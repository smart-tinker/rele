using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

internal static class DesktopToolsPipeFixture
{
    private static int checks;
    private static void Check(bool value, string code) { if (!value) throw new InvalidOperationException(code); checks++; }
    private static string Key() { return Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N"); }

    private static int Main()
    {
        try
        {
            string sid = WindowsIdentity.GetCurrent().User.Value;
            uint session = checked((uint)Process.GetCurrentProcess().SessionId);
            Check(DesktopToolsPipe.IsDesktopPipeName("codex-app-tools-" + Guid.NewGuid().ToString("D")), "desktop-pipe-name");
            foreach (string name in new[] { "codex-app-tools-123", "codex-app-tools-..\\other", "foreign-" + Guid.NewGuid().ToString("D") })
                Check(!DesktopToolsPipe.IsDesktopPipeName(name), "unsafe-desktop-pipe-name");
            Check(DesktopToolsPipe.IsDesktopIdentity(sid, session, sid, session, @"C:\Package\ChatGPT.exe", "OpenAI.Codex_2p2nqsd0c76g0", 1), "desktop-identity");
            Check(!DesktopToolsPipe.IsDesktopIdentity(sid, session, sid + "-1", session, @"C:\Package\ChatGPT.exe", "OpenAI.Codex_2p2nqsd0c76g0", 1), "foreign-sid");
            Check(!DesktopToolsPipe.IsDesktopIdentity(sid, session, sid, session + 1, @"C:\Package\ChatGPT.exe", "OpenAI.Codex_2p2nqsd0c76g0", 1), "foreign-session");
            Check(!DesktopToolsPipe.IsDesktopIdentity(sid, session, sid, session, @"C:\Package\ChatGPT.exe", "Foreign.Package", 1), "package-not-name-only");
            Check(!DesktopToolsPipe.IsDesktopIdentity(sid, session, sid, session, @"C:\Package\node.exe", "OpenAI.Codex_2p2nqsd0c76g0", 1), "package-image");
            Check(!DesktopToolsPipe.IsDesktopIdentity(sid, session, sid, session, @"C:\Package\ChatGPT.exe", "OpenAI.Codex_2p2nqsd0c76g0", 0), "kernel-birth-required");

            int discoveries = 0;
            FakeDesktop selected = new FakeDesktop();
            try
            {
                string key = Key();
                using (var relay = new DesktopToolsPipe(key, process => true, delegate {
                    Interlocked.Increment(ref discoveries); return selected.Connect();
                }))
                {
                    bool duplicate = false;
                    try { using (var ignored = new DesktopToolsPipe(key, process => true)) { } }
                    catch (InvalidOperationException) { duplicate = true; }
                    Check(duplicate, "first-instance-ownership");
                    using (NamedPipeClientStream first = Client(relay.PipePath))
                    {
                        var acl = first.GetAccessControl();
                        bool ownGrant = false;
                        foreach (PipeAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
                            if (rule.AccessControlType == AccessControlType.Allow) { Check(rule.IdentityReference.Value == sid, "private-acl"); ownGrant = true; }
                        Check(ownGrant && acl.AreAccessRulesProtected, "private-acl-present");
                        RoundTrip(first, Payload(65539));
                        selected.Dispose();
                        Closed(first);
                    }
                    selected = new FakeDesktop();
                    using (NamedPipeClientStream second = Client(relay.PipePath)) RoundTrip(second, Payload(4097));
                    Check(discoveries == 2, "rediscovery-per-connection-no-replay");
                }
            }
            finally { selected.Dispose(); }

            var parallelPeers = new List<FakeDesktop>();
            var parallelClients = new List<NamedPipeClientStream>();
            try
            {
                using (var relay = new DesktopToolsPipe(Key(), process => true, delegate {
                    var peer = new FakeDesktop();
                    lock (parallelPeers) parallelPeers.Add(peer);
                    return peer.Connect();
                }))
                {
                    for (int index = 0; index < 9; index++) parallelClients.Add(Client(relay.PipePath));
                    foreach (NamedPipeClientStream client in parallelClients) RoundTrip(client, Payload(129));
                    lock (parallelPeers) Check(parallelPeers.Count == 9, "more-than-eight-persistent-clients");
                }
            }
            finally
            {
                foreach (NamedPipeClientStream client in parallelClients) client.Dispose();
                lock (parallelPeers) foreach (FakeDesktop peer in parallelPeers) peer.Dispose();
            }

            int deniedDiscovery = 0;
            using (var relay = new DesktopToolsPipe(Key(), process => false, delegate { Interlocked.Increment(ref deniedDiscovery); throw new IOException(); }))
            using (NamedPipeClientStream client = Client(relay.PipePath))
            {
                Closed(client);
                Check(deniedDiscovery == 0, "foreign-job-rejected-before-upstream");
            }
            using (var relay = new DesktopToolsPipe(Key(), process => true, delegate { throw new IOException(); }))
            using (NamedPipeClientStream client = Client(relay.PipePath)) Closed(client);

            using (var one = new FakeDesktop()) using (var two = new FakeDesktop())
            using (var relay = new DesktopToolsPipe(Key(), process => true, delegate {
                var peers = new List<DesktopToolsPipe.DesktopConnection> { one.Connect(), two.Connect() };
                try { return DesktopToolsPipe.Single(peers); }
                catch { foreach (var peer in peers) peer.Dispose(); throw; }
            }))
            using (NamedPipeClientStream client = Client(relay.PipePath))
            {
                Closed(client);
                Check(one.Bytes == 0 && two.Bytes == 0, "ambiguous-desktop-no-forwarding");
            }
            Console.Out.WriteLine("{\"result\":\"passed\",\"checks\":" + checks + ",\"rawDuplex\":true,\"reconnect\":true,\"noReplay\":true,\"privateAcl\":true,\"foreignDenial\":true,\"ambiguity\":true,\"actualDesktop\":false}");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Desktop pipe fixture: " + (error is InvalidOperationException ? error.Message : "windows-pipe-operation"));
            return 1;
        }
    }

    private static NamedPipeClientStream Client(string path)
    {
        var client = new NamedPipeClientStream(".", Path.GetFileName(path), PipeDirection.InOut, PipeOptions.Asynchronous);
        client.Connect(3000);
        return client;
    }

    private static byte[] Payload(int length)
    {
        var result = new byte[length];
        for (int index = 0; index < length; index++) result[index] = (byte)(index % 251);
        return result;
    }

    private static void RoundTrip(NamedPipeClientStream client, byte[] bytes)
    {
        Task write = Task.Factory.StartNew(delegate { client.Write(bytes, 0, bytes.Length); client.Flush(); });
        var received = new byte[bytes.Length];
        Task read = Task.Factory.StartNew(delegate {
            int offset = 0;
            while (offset < received.Length) { int count = client.Read(received, offset, Math.Min(1023, received.Length - offset)); if (count == 0) throw new InvalidOperationException("premature-eof"); offset += count; }
        });
        Check(Task.WaitAll(new[] { write, read }, 15000), "raw-duplex-timeout");
        Check(Convert.ToBase64String(bytes) == Convert.ToBase64String(received), "raw-bytes-unchanged");
    }

    private static void Closed(NamedPipeClientStream client)
    {
        Task<bool> read = Task.Factory.StartNew(delegate {
            try { return client.ReadByte() == -1; } catch (IOException) { return true; }
        });
        Check(read.Wait(3000) && read.Result, "peer-disconnect-not-closed");
    }

    private sealed class FakeDesktop : IDisposable
    {
        private readonly string name = "rele-desktop-fixture-" + Guid.NewGuid().ToString("N");
        private readonly NamedPipeServerStream pipe;
        internal int Bytes;
        internal FakeDesktop()
        {
            pipe = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
            var thread = new Thread(new ThreadStart(delegate {
                try
                {
                    pipe.WaitForConnection();
                    byte[] chunk = new byte[997];
                    int count;
                    while ((count = pipe.Read(chunk, 0, chunk.Length)) != 0) { Interlocked.Add(ref Bytes, count); pipe.Write(chunk, 0, count); }
                }
                catch { }
            }));
            thread.IsBackground = true; thread.Start();
        }
        internal DesktopToolsPipe.DesktopConnection Connect()
        {
            var client = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
            client.Connect(1000);
            return new DesktopToolsPipe.DesktopConnection(client, OpenProcess(0x101000, false, checked((uint)Process.GetCurrentProcess().Id)));
        }
        public void Dispose() { pipe.Dispose(); }
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeFileHandle OpenProcess(uint access, bool inherit, uint pid);
}
