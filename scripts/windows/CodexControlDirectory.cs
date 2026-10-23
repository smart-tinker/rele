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
using Microsoft.Win32.SafeHandles;

// One guarded migration of Codex's old control namespace. Never changes an existing inode's ACL.
internal static class CodexControlDirectory
{
    private const uint ReadControl = 0x20000, ReadAttributes = 0x80, Delete = 0x10000;
    private const uint OpenReparse = 0x200000, BackupSemantics = 0x2000000;
    private const uint DirectoryAttribute = 0x10, ReparseAttribute = 0x400, UnixSocketTag = 0x80000023;
    private const int FullControl = 0x1f01ff;

    internal static int Run(string[] args)
    {
        try
        {
            if (args.Length < 4 || args[0] != "--repair-codex-control" || args[2] != "--" ||
                !Path.IsPathRooted(args[3]) || !File.Exists(args[3])) Fail("invalid-arguments");
            Migrate(args);
            return 0;
        }
        catch (Exception error)
        {
            string code = error is MigrationFailure ? error.Message : "windows-operation-failed";
            Console.Error.WriteLine("Rele Codex control: " + code);
            return 1;
        }
    }

    private static void Migrate(string[] args)
    {
        string home = Path.GetFullPath(args[1]).TrimEnd('\\');
        if (!Path.IsPathRooted(args[1]) || home.StartsWith("\\", StringComparison.Ordinal) ||
            home.Length <= 3 || !String.Equals(home, args[1].TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) Fail("invalid-profile");
        WindowsIdentity identity = WindowsIdentity.GetCurrent();
        if (new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator)) Fail("elevated-process");
        SecurityIdentifier user = identity.User;
        var guards = new List<SafeFileHandle>();
        try
        {
            // Pin every existing ancestor, so neither the profile nor its parent can be redirected.
            string ancestor = Path.GetPathRoot(home);
            foreach (string part in home.Substring(ancestor.Length).Split('\\'))
            {
                ancestor = Path.Combine(ancestor, part);
                SafeFileHandle held = Open(ancestor, ReadControl | ReadAttributes, true);
                guards.Add(held);
                RequireDirectory(held, ancestor);
            }
            SafeFileHandle homeHandle = guards[guards.Count - 1];
            RequireOwner(homeHandle, user);
            string control = Path.Combine(home, "app-server-control");
            SafeFileHandle old = OpenOptional(control, ReadControl | ReadAttributes | Delete, true);
            if (old == null) { Unchanged(); return; }
            guards.Add(old);
            RequireDirectory(old, control);
            RawSecurityDescriptor oldSecurity = RequireOwner(old, user);
            CheckEntries(control, user);
            if (IsPrivate(oldSecurity, user)) { Unchanged(); return; }

            string state = Path.Combine(home, "app-server-daemon");
            SafeFileHandle stateHandle = OpenOptional(state, ReadControl | ReadAttributes, true);
            if (stateHandle == null)
            {
                CreatePrivate(state, user);
                stateHandle = Open(state, ReadControl | ReadAttributes, true);
            }
            guards.Add(stateHandle);
            RequireDirectory(stateHandle, state);
            if (!IsPrivate(RequireOwner(stateHandle, user), user)) Fail("daemon-state-not-private");
            string lockPath = Path.Combine(state, "daemon.lock");
            using (SafeFileHandle operation = CreateFile(lockPath, 0xc0020080, 3, IntPtr.Zero, 4, OpenReparse, IntPtr.Zero))
            {
                if (operation.IsInvalid) Fail("operation-lock-open");
                RequireRegular(operation);
                RequireOwner(operation, user);
                var overlap = new Overlapped();
                if (!LockFileEx(operation, 3, 0, 1, 0, ref overlap)) Fail("operation-lock-unavailable");
                // Do not mutate after a timeout, malformed response, or an unclassified native failure.
                if (Ready(args, home, Path.Combine(control, "app-server-control.sock"))) { Unchanged(); return; }
                RequireDirectory(old, control);
                RequireOwner(old, user);
                CheckEntries(control, user);
                string nonce = Guid.NewGuid().ToString("N");
                string staging = Path.Combine(home, ".rele-codex-control-" + nonce);
                string backup = Path.Combine(home, "app-server-control.rele-backup-" + nonce);
                CreatePrivate(staging, user);
                using (SafeFileHandle fresh = Open(staging, ReadControl | ReadAttributes | Delete, true))
                {
                    RequireDirectory(fresh, staging);
                    if (!IsPrivate(RequireOwner(fresh, user), user)) Fail("staging-not-private");
                    bool movedOld = false, published = false;
                    try
                    {
                        Rename(old, backup); movedOld = true;
                        Rename(fresh, control); published = true;
                        RequireDirectory(fresh, control);
                        if (!IsPrivate(RequireOwner(fresh, user), user)) Fail("published-not-private");
                    }
                    catch
                    {
                        // No replacement or deletion: a concurrent owner makes rollback fail closed.
                        try
                        {
                            if (published) Rename(fresh, staging);
                            if (movedOld) Rename(old, control);
                        }
                        catch { Fail("migration-rollback-unconfirmed"); }
                        Fail("migration-publication-failed");
                    }
                }
                Console.Out.WriteLine("{\"status\":\"migrated\"}");
            }
        }
        finally { for (int index = guards.Count - 1; index >= 0; index--) guards[index].Dispose(); }
    }

    private static void Unchanged() { Console.Out.WriteLine("{\"status\":\"unchanged\"}"); }

    private static void CheckEntries(string directory, SecurityIdentifier user)
    {
        foreach (string entry in Directory.GetFileSystemEntries(directory))
        {
            string name = Path.GetFileName(entry);
            bool socket = String.Equals(name, "app-server-control.sock", StringComparison.Ordinal);
            if (!socket && name != "app-server-startup.lock" && name != "app-server.log") Fail("unknown-control-entry");
            // Close child handles before renaming their parent. The pinned parent is moved whole
            // to backup; none of its entries or ACLs are copied into the fresh private directory.
            using (SafeFileHandle leaf = Open(entry, ReadControl | ReadAttributes, false))
            {
                AttributeTag attributes = Attributes(leaf);
                if ((attributes.Attributes & DirectoryAttribute) != 0 ||
                    ((attributes.Attributes & ReparseAttribute) != 0 && (!socket || attributes.Tag != UnixSocketTag))) Fail("unsafe-control-entry");
                RequireOwner(leaf, user);
            }
        }
    }

    private static RawSecurityDescriptor RequireOwner(SafeFileHandle handle, SecurityIdentifier user)
    {
        IntPtr owner, group, dacl, sacl, descriptor;
        if (GetSecurityInfo(handle, 1, 5, out owner, out group, out dacl, out sacl, out descriptor) != 0) Fail("security-read-failed");
        try
        {
            byte[] binary = new byte[GetSecurityDescriptorLength(descriptor)];
            Marshal.Copy(descriptor, binary, 0, binary.Length);
            var security = new RawSecurityDescriptor(binary, 0);
            if (security.Owner == null || !security.Owner.Equals(user)) Fail("foreign-owner");
            return security;
        }
        finally { LocalFree(descriptor); }
    }

    private static bool IsPrivate(RawSecurityDescriptor security, SecurityIdentifier user)
    {
        if ((security.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0 ||
            security.DiscretionaryAcl == null || security.DiscretionaryAcl.Count != 1) return false;
        CommonAce ace = security.DiscretionaryAcl[0] as CommonAce;
        return ace != null && ace.AceType == AceType.AccessAllowed && !ace.IsCallback && ace.AccessMask == FullControl &&
            ace.AceFlags == (AceFlags.ObjectInherit | AceFlags.ContainerInherit) && ace.SecurityIdentifier.Equals(user);
    }

    private static void CreatePrivate(string directory, SecurityIdentifier user)
    {
        var descriptor = new RawSecurityDescriptor("O:" + user.Value + "D:P(A;OICI;FA;;;" + user.Value + ")");
        byte[] binary = new byte[descriptor.BinaryLength];
        descriptor.GetBinaryForm(binary, 0);
        GCHandle pinned = GCHandle.Alloc(binary, GCHandleType.Pinned);
        try
        {
            var security = new SecurityAttributes();
            security.Length = Marshal.SizeOf(typeof(SecurityAttributes));
            security.Descriptor = pinned.AddrOfPinnedObject();
            if (!CreateDirectory(directory, ref security)) Fail("private-directory-create");
        }
        finally { pinned.Free(); }
    }

    private static SafeFileHandle OpenOptional(string path, uint access, bool directory)
    {
        SafeFileHandle handle = CreateFile(path, access, 3, IntPtr.Zero, 3, OpenReparse | (directory ? BackupSemantics : 0), IntPtr.Zero);
        if (!handle.IsInvalid) return handle;
        int error = Marshal.GetLastWin32Error();
        handle.Dispose();
        if (error == 2 || error == 3) return null;
        Fail("path-open-failed"); return null;
    }

    private static SafeFileHandle Open(string path, uint access, bool directory)
    {
        SafeFileHandle handle = OpenOptional(path, access, directory);
        if (handle == null) Fail("path-disappeared");
        return handle;
    }

    private static AttributeTag Attributes(SafeFileHandle handle)
    {
        AttributeTag attributes;
        if (!GetFileInformationByHandleEx(handle, 9, out attributes, (uint)Marshal.SizeOf(typeof(AttributeTag)))) Fail("path-attributes-failed");
        return attributes;
    }

    private static void RequireRegular(SafeFileHandle handle)
    {
        if ((Attributes(handle).Attributes & (DirectoryAttribute | ReparseAttribute)) != 0) Fail("unsafe-lock-file");
    }

    private static void RequireDirectory(SafeFileHandle handle, string expected)
    {
        AttributeTag attributes = Attributes(handle);
        if ((attributes.Attributes & DirectoryAttribute) == 0 || (attributes.Attributes & ReparseAttribute) != 0) Fail("unsafe-directory");
        var actual = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandle(handle, actual, (uint)actual.Capacity, 0);
        if (length == 0 || length >= actual.Capacity) Fail("path-identity-failed");
        string name = actual.ToString();
        if (name.StartsWith("\\\\?\\", StringComparison.Ordinal)) name = name.Substring(4);
        if (!String.Equals(name.TrimEnd('\\'), expected.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) Fail("path-identity-mismatch");
    }

    private static void Rename(SafeFileHandle handle, string destination)
    {
        // FILE_RENAME_INFO is pointer-aligned on x64; ReplaceIfExists remains false.
        byte[] name = Encoding.Unicode.GetBytes(destination);
        int nameOffset = IntPtr.Size == 8 ? 20 : 12;
        IntPtr information = Marshal.AllocHGlobal(nameOffset + name.Length);
        try
        {
            for (int index = 0; index < nameOffset; index++) Marshal.WriteByte(information, index, 0);
            Marshal.WriteInt32(information, nameOffset - 4, name.Length);
            Marshal.Copy(name, 0, IntPtr.Add(information, nameOffset), name.Length);
            if (!SetFileInformationByHandle(handle, 3, information, (uint)(nameOffset + name.Length))) Fail("directory-rename-failed");
        }
        finally { Marshal.FreeHGlobal(information); }
    }

    private static bool Ready(string[] args, string home, string socket)
    {
        var command = new StringBuilder();
        for (int index = 3; index < args.Length; index++) command.Append(ProcessHost.Quote(args[index])).Append(' ');
        command.Append("app-server daemon version");
        if (command.Length >= 32767) Fail("native-probe-arguments");
        // This changes only the short-lived helper's environment, never persisted user settings.
        Environment.SetEnvironmentVariable("CODEX_HOME", home);
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) Fail("native-probe-job");
        ProcessInformation child = new ProcessInformation();
        bool assigned = false;
        var output = new Capture(); var errors = new Capture();
        var elapsed = Stopwatch.StartNew();
        try
        {
            var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE, no breakaway.
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) Fail("native-probe-job");
            using (var input = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable))
            using (var stdout = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable))
            using (var stderr = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable))
            {
                var startup = new StartupInfo(); startup.Size = Marshal.SizeOf(typeof(StartupInfo)); startup.Flags = 0x100;
                startup.Input = input.ClientSafePipeHandle.DangerousGetHandle();
                startup.Output = stdout.ClientSafePipeHandle.DangerousGetHandle();
                startup.Error = stderr.ClientSafePipeHandle.DangerousGetHandle();
                if (!CreateProcess(args[3], command, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, null, ref startup, out child)) Fail("native-probe-create");
                // The selected CLI and any official Node entry children belong to this Job before execution.
                if (!AssignProcessToJobObject(job, child.Process)) Fail("native-probe-job-assign");
                assigned = true;
                input.DisposeLocalCopyOfClientHandle(); stdout.DisposeLocalCopyOfClientHandle(); stderr.DisposeLocalCopyOfClientHandle();
                var outputReader = new Thread(() => CapturePipe(stdout, output)); outputReader.IsBackground = true; outputReader.Start();
                var errorReader = new Thread(() => CapturePipe(stderr, errors)); errorReader.IsBackground = true; errorReader.Start();
                input.Close();
                if (ResumeThread(child.Thread) == UInt32.MaxValue) Fail("native-probe-resume");
                if (WaitForSingleObject(child.Process, Remaining(elapsed)) != 0) Fail("native-probe-timeout");
                if (!output.Done.WaitOne((int)Remaining(elapsed)) || !errors.Done.WaitOne((int)Remaining(elapsed))) Fail("native-probe-timeout");
                if (output.Failed || errors.Failed) Fail("native-probe-output-limit");
                uint code;
                if (!GetExitCodeProcess(child.Process, out code)) Fail("native-probe-exit");
                if (code == 0) return true;
                if (code != 1 || !String.IsNullOrWhiteSpace(output.Text.ToString()) ||
                    !Regex.IsMatch(errors.Text.ToString(), "failed to connect to " + Regex.Escape(socket) + @"[\s\S]*\(os error (?:2|10061)\)", RegexOptions.CultureInvariant)) Fail("native-probe-unconfirmed");
                return false;
            }
        }
        finally
        {
            // Also removes descendants after a natural CLI exit; never touches another process tree.
            if (child.Process != IntPtr.Zero)
            {
                if (assigned) TerminateJobObject(job, 1); else TerminateProcess(child.Process, 1);
                WaitForSingleObject(child.Process, 500);
                CloseHandle(child.Thread); CloseHandle(child.Process);
            }
            CloseHandle(job);
        }
    }

    private sealed class Capture
    {
        internal readonly StringBuilder Text = new StringBuilder();
        internal readonly ManualResetEvent Done = new ManualResetEvent(false);
        internal bool Failed;
    }
    private static void CapturePipe(Stream stream, Capture capture)
    {
        try
        {
            using (var reader = new StreamReader(stream, Encoding.UTF8))
            {
                var buffer = new char[4096]; int count;
                while ((count = reader.Read(buffer, 0, buffer.Length)) != 0)
                {
                    if (capture.Text.Length + count > 128 * 1024) { capture.Failed = true; break; }
                    capture.Text.Append(buffer, 0, count);
                }
            }
        }
        catch { capture.Failed = true; }
        finally { capture.Done.Set(); }
    }
    private static uint Remaining(Stopwatch elapsed) { return (uint)Math.Max(0, 5000 - elapsed.ElapsedMilliseconds); }

    private sealed class MigrationFailure : Exception { internal MigrationFailure(string code) : base(code) {} }
    private static void Fail(string code) { throw new MigrationFailure(code); }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo
    {
        public int Size; public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        public ushort ShowWindow, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInformation { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits
    {
        public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorking, MaxWorking;
        public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation child);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits information, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)] private struct AttributeTag { public uint Attributes, Tag; }
    [StructLayout(LayoutKind.Sequential)] private struct Overlapped { public UIntPtr Internal, InternalHigh; public uint Offset, OffsetHigh; public IntPtr Event; }
    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateDirectory(string name, ref SecurityAttributes security);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, out AttributeTag information, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder name, uint capacity, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, IntPtr information, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool LockFileEx(SafeFileHandle handle, uint flags, uint reserved, uint low, uint high, ref Overlapped overlap);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")] private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
}
