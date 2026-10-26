using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

// A transport only: Desktop remains responsible for every app-tools request and response.
internal sealed class DesktopToolsPipe : IDisposable
{
    private const string DesktopFamily = "OpenAI.Codex_2p2nqsd0c76g0";
    private const string DesktopPrefix = "codex-app-tools-";
    private const uint QueryProcess = 0x1000, Synchronize = 0x100000;
    private readonly string sid;
    private readonly uint session;
    private readonly Func<SafeFileHandle, bool> isNativeChild;
    private readonly Func<DesktopConnection> discover;
    private readonly object gate = new object();
    private readonly HashSet<PipeStream> streams = new HashSet<PipeStream>();
    private NamedPipeServerStream listener;
    private bool disposed;
    private int connections;
    internal readonly string PipePath;

    internal DesktopToolsPipe(string ownerKey, Func<SafeFileHandle, bool> isNativeChild)
        : this(ownerKey, isNativeChild, null) { }

    // The fixture injects peers; production always uses kernel/package-bound discovery below.
    internal DesktopToolsPipe(string ownerKey, Func<SafeFileHandle, bool> isNativeChild, Func<DesktopConnection> discover)
    {
        if (!Regex.IsMatch(ownerKey ?? "", "^[a-f0-9]{64}$")) throw new InvalidOperationException("invalid app-tools owner key");
        this.isNativeChild = isNativeChild;
        this.discover = discover ?? new Func<DesktopConnection>(ConnectDesktop);
        sid = WindowsIdentity.GetCurrent().User.Value;
        session = checked((uint)Process.GetCurrentProcess().SessionId);
        PipePath = @"\\.\pipe\rele-codex-app-tools-" + ownerKey;
        listener = NewListener(true);
        var thread = new Thread(Accept);
        thread.IsBackground = true;
        thread.Start();
    }

    private NamedPipeServerStream NewListener(bool first)
    {
        var security = new PipeSecurity();
        var user = new SecurityIdentifier(sid);
        security.SetOwner(user);
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new PipeAccessRule(user, PipeAccessRights.FullControl, AccessControlType.Allow));
        byte[] descriptor = security.GetSecurityDescriptorBinaryForm();
        var pinned = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
        try
        {
            var attributes = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = pinned.AddrOfPinnedObject() };
            // First-instance ownership prevents attaching to another server's namespace. Remote clients are never admitted.
            SafePipeHandle pipe = CreateNamedPipe(PipePath, 3u | 0x40000000u | (first ? 0x80000u : 0u), 8, 255, 16384, 16384, 0, ref attributes);
            if (pipe.IsInvalid) { pipe.Dispose(); throw new InvalidOperationException("app-tools private pipe unavailable"); }
            try { return new NamedPipeServerStream(PipeDirection.InOut, true, false, pipe); }
            catch { pipe.Dispose(); throw; }
        }
        finally { pinned.Free(); }
    }

    private void Accept()
    {
        try
        {
            while (true)
            {
                NamedPipeServerStream client;
                lock (gate) { if (disposed) return; client = listener; }
                client.WaitForConnection();
                lock (gate)
                {
                    if (disposed) { client.Dispose(); return; }
                    // Keep the namespace held while existing connections are handed to their workers.
                    listener = NewListener(false);
                    // Loaded chats retain idle MCP sockets; cap connections rather than limiting them to eight chats.
                    if (connections >= 64) { client.Dispose(); continue; }
                    connections++;
                    streams.Add(client);
                }
                ThreadPool.QueueUserWorkItem(delegate { Relay(client); });
            }
        }
        catch { Dispose(); } // Relay failure never stops or restarts the native server.
    }

    private void Relay(NamedPipeServerStream client)
    {
        DesktopConnection upstream = null;
        Task incoming = null, outgoing = null;
        try
        {
            if (!AllowedClient(client)) return;
            upstream = discover();
            if (upstream == null || !upstream.Alive()) return;
            lock (gate) { if (disposed) return; streams.Add(upstream.Pipe); }
            incoming = client.CopyToAsync(upstream.Pipe, 16384);
            outgoing = upstream.Pipe.CopyToAsync(client, 16384);
            Task.WaitAny(incoming, outgoing);
        }
        catch { }
        finally
        {
            client.Dispose();
            if (upstream != null) upstream.Dispose();
            // Observe failures without waiting for a peer or replaying any bytes on a fresh pipe.
            foreach (Task copy in new[] { incoming, outgoing }) if (copy != null)
                copy.ContinueWith(task => { var ignored = task.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
            lock (gate)
            {
                streams.Remove(client);
                if (upstream != null) streams.Remove(upstream.Pipe);
                connections--;
            }
        }
    }

    private bool AllowedClient(NamedPipeServerStream pipe)
    {
        uint pid, peerSession;
        if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out pid) || !GetNamedPipeClientSessionId(pipe.SafePipeHandle, out peerSession) || peerSession != session) return false;
        using (SafeFileHandle process = OpenProcess(QueryProcess | Synchronize, false, pid))
        {
            Peer identity = ReadPeer(process, pid);
            uint confirmed;
            return identity != null && identity.Sid == sid && identity.Session == session &&
                isNativeChild(process) && GetNamedPipeClientProcessId(pipe.SafePipeHandle, out confirmed) && confirmed == pid && Alive(process);
        }
    }

    private DesktopConnection ConnectDesktop()
    {
        string[] names = Directory.GetFiles(@"\\.\pipe\", DesktopPrefix + "*");
        if (names.Length > 64) throw new InvalidOperationException("app-tools discovery is ambiguous");
        var candidates = new List<DesktopConnection>();
        try
        {
            foreach (string path in names)
            {
                string name = Path.GetFileName(path);
                if (!IsDesktopPipeName(name)) continue;
                NamedPipeClientStream pipe = null;
                SafeFileHandle process = null;
                try
                {
                    pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Identification);
                    pipe.Connect(50);
                    uint pid, peerSession;
                    if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out pid) || !GetNamedPipeServerSessionId(pipe.SafePipeHandle, out peerSession) || peerSession != session) continue;
                    process = OpenProcess(QueryProcess | Synchronize, false, pid);
                    Peer peer = ReadPeer(process, pid);
                    if (peer == null || !IsDesktopIdentity(sid, session, peer.Sid, peer.Session, peer.Image, PackageFamily(process), peer.Birth)) continue;
                    uint confirmed;
                    if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out confirmed) || confirmed != pid || !Alive(process)) continue;
                    candidates.Add(new DesktopConnection(pipe, process));
                    pipe = null; process = null;
                }
                catch { }
                finally { if (pipe != null) pipe.Dispose(); if (process != null) process.Dispose(); }
            }
            DesktopConnection result = Single(candidates);
            candidates.Clear();
            return result;
        }
        finally { foreach (DesktopConnection candidate in candidates) candidate.Dispose(); }
    }

    internal static bool IsDesktopPipeName(string name)
    {
        Guid id;
        return name != null && name.StartsWith(DesktopPrefix, StringComparison.Ordinal) &&
            Guid.TryParseExact(name.Substring(DesktopPrefix.Length), "D", out id);
    }

    internal static bool IsDesktopIdentity(string ownerSid, uint ownerSession, string peerSid, uint peerSession, string image, string family, long birth)
    {
        return ownerSid == peerSid && ownerSession == peerSession && birth > 0 &&
            family == DesktopFamily && Path.IsPathRooted(image ?? "") &&
            String.Equals(Path.GetFileName(image), "ChatGPT.exe", StringComparison.OrdinalIgnoreCase);
    }

    internal static DesktopConnection Single(IList<DesktopConnection> candidates)
    {
        if (candidates.Count != 1) throw new InvalidOperationException("app-tools Desktop is absent or ambiguous");
        return candidates[0];
    }

    internal sealed class DesktopConnection : IDisposable
    {
        internal readonly NamedPipeClientStream Pipe;
        private readonly SafeFileHandle process;
        internal DesktopConnection(NamedPipeClientStream pipe, SafeFileHandle process) { Pipe = pipe; this.process = process; }
        internal bool Alive() { return process != null && DesktopToolsPipe.Alive(process); }
        public void Dispose() { Pipe.Dispose(); if (process != null) process.Dispose(); }
    }

    private sealed class Peer { internal string Sid, Image; internal uint Session; internal long Birth; }

    private static Peer ReadPeer(SafeFileHandle process, uint pid)
    {
        if (process == null || process.IsInvalid || !Alive(process)) return null;
        long birth, exit, kernel, user;
        uint session;
        var image = new StringBuilder(32768);
        int length = image.Capacity;
        IntPtr token;
        if (!GetProcessTimes(process, out birth, out exit, out kernel, out user) || birth <= 0 ||
            !ProcessIdToSessionId(pid, out session) || !QueryFullProcessImageName(process, 0, image, ref length) ||
            !OpenProcessToken(process, 8, out token)) return null;
        string sid;
        try { using (var identity = new WindowsIdentity(token)) sid = identity.User.Value; }
        finally { CloseHandle(token); }
        return Alive(process) ? new Peer { Sid = sid, Session = session, Image = image.ToString(), Birth = birth } : null;
    }

    private static string PackageFamily(SafeFileHandle process)
    {
        uint length = 0;
        if (GetPackageFamilyName(process, ref length, null) != 122 || length == 0 || length > 256) return null;
        var family = new StringBuilder(checked((int)length));
        return GetPackageFamilyName(process, ref length, family) == 0 ? family.ToString() : null;
    }

    private static bool Alive(SafeFileHandle process) { return !process.IsInvalid && WaitForSingleObject(process, 0) == 258; }

    public void Dispose()
    {
        lock (gate)
        {
            if (disposed) return;
            disposed = true;
            listener.Dispose();
            foreach (PipeStream stream in streams) stream.Dispose();
            streams.Clear();
        }
    }

    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes
    { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode, uint max, uint output, uint input, uint timeout, ref SecurityAttributes attributes);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeClientSessionId(SafePipeHandle pipe, out uint session);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeServerSessionId(SafePipeHandle pipe, out uint session);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeFileHandle OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(SafeFileHandle process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool ProcessIdToSessionId(uint pid, out uint session);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageName(SafeFileHandle process, uint flags, StringBuilder image, ref int length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern int GetPackageFamilyName(SafeFileHandle process, ref uint length, StringBuilder family);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(SafeFileHandle process, uint access, out IntPtr token);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(SafeFileHandle process, uint milliseconds);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
}
