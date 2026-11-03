using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Internal byte-transparent host. Its private Job owns the child before the child can run.
internal sealed class ProcessHost : IDisposable
{
    private const uint KillOnJobClose = 0x2000;
    private const uint CreateSuspended = 0x00000004;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint CreateNoWindow = 0x08000000;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 258;
    private const int ShutdownMilliseconds = 10000;
    private IntPtr job;
    private IntPtr process;
    private IntPtr primaryThread;
    private SafeFileHandle childInput;
    private bool assigned;
    private bool stopAttempted;
    private bool stopped;
    private readonly ManualResetEvent stopRequested = new ManualResetEvent(false);
    private string relayFailure;
    private bool websocketOwner;
    private DesktopToolsPipe desktopTools;
    private uint childPid;
    private string childStartedAt;

    private sealed class WebSocketOwner
    {
        public int Version { get; set; }
        public string OwnerSid { get; set; }
        public string Executable { get; set; }
        public string ExecutableSha256 { get; set; }
        public string HostSha256 { get; set; }
        public string CodexHome { get; set; }
        public string Endpoint { get; set; }
        public string TaskName { get; set; }
        public string UpdatePredecessorDirectory { get; set; }
        public string PreviousScheduledDirectory { get; set; }
    }

    private static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--repair-codex-control") return CodexControlDirectory.Run(args);
        if (args.Length > 0 && args[0] == "--codex-websocket-owner") return RunWebSocketOwner(args);
        using (var host = new ProcessHost())
        {
            try
            {
                if (args.Length < 2 || args[0] != "--" || String.IsNullOrEmpty(args[1]))
                    throw new InvalidOperationException("expected -- followed by an executable and its arguments");
                host.Start(args);
                host.WaitForStop();
                host.Stop();
                if (host.relayFailure != null) throw new InvalidOperationException(host.relayFailure);
                return 0;
            }
            catch (Exception error)
            {
                Report(error is InvalidOperationException ? error.Message : "unexpected process host failure");
                return 1;
            }
        }
    }

    private static int RunWebSocketOwner(string[] args)
    {
        try
        {
            if (args.Length != 2 || !Path.IsPathRooted(args[1]) || Path.GetFileName(args[1]) != "owner.json")
                throw new InvalidOperationException("invalid WebSocket owner marker");
            string directory = Path.GetDirectoryName(Path.GetFullPath(args[1]));
            RequirePrivateDirectory(directory);
            var json = new JavaScriptSerializer();
            string marker = File.ReadAllText(args[1]);
            WebSocketOwner owner = json.Deserialize<WebSocketOwner>(marker);
            using (var hash = SHA256.Create())
                if (BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(marker))).Replace("-", "").ToLowerInvariant() != Path.GetFileName(directory))
                    throw new InvalidOperationException("WebSocket owner marker changed");
            Uri endpoint;
            if (owner == null || owner.Version != 1 || owner.OwnerSid != WindowsIdentity.GetCurrent().User.Value ||
                !Uri.TryCreate(owner.Endpoint, UriKind.Absolute, out endpoint) || endpoint.Scheme != "ws" || endpoint.Host != "127.0.0.1" ||
                endpoint.Port <= 0 || endpoint.Port > 65535 || endpoint.AbsolutePath != "/" || !String.IsNullOrEmpty(endpoint.Query) ||
                !String.IsNullOrEmpty(endpoint.Fragment) || !String.IsNullOrEmpty(endpoint.UserInfo) ||
                !Path.IsPathRooted(owner.CodexHome) || !Path.IsPathRooted(owner.Executable) ||
                !Regex.IsMatch(owner.TaskName ?? "", @"^Rele-[A-Za-z0-9._-]{1,130}$") ||
                !Regex.IsMatch(owner.ExecutableSha256 ?? "", "^[a-f0-9]{64}$") ||
                !Regex.IsMatch(owner.HostSha256 ?? "", "^[a-f0-9]{64}$"))
                throw new InvalidOperationException("WebSocket owner identity does not match");
            string executable = Process.GetCurrentProcess().MainModule.FileName;
            if (!String.Equals(Path.GetDirectoryName(executable), directory, StringComparison.OrdinalIgnoreCase) ||
                Hash(executable) != owner.HostSha256 || Hash(owner.Executable) != owner.ExecutableSha256)
                throw new InvalidOperationException("WebSocket owner executable changed");
            // The task is independent of Rele's gateway; only this host owns the native child Job.
            using (var predecessor = LockUpdatePredecessor(directory, owner))
            using (var operation = new FileStream(Path.Combine(directory, "owner.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None))
            using (var native = new FileStream(owner.Executable, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var host = new ProcessHost())
            {
                Environment.SetEnvironmentVariable("CODEX_HOME", owner.CodexHome);
                Environment.SetEnvironmentVariable("CODEX_CLI_PATH", null);
                Environment.SetEnvironmentVariable("CODEX_APP_SERVER_FORCE_CLI", null);
                Environment.SetEnvironmentVariable("CODEX_APP_SERVER_WS_URL", null);
                host.websocketOwner = true;
                using (var hash = SHA256.Create())
                    if (BitConverter.ToString(hash.ComputeHash(native)).Replace("-", "").ToLowerInvariant() != owner.ExecutableSha256)
                        throw new InvalidOperationException("native executable changed before launch");
                try { host.desktopTools = new DesktopToolsPipe(Path.GetFileName(directory), host.IsNativeChild); }
                catch { Report("Desktop app-tools relay unavailable"); }
                host.Start(new[] { "--", owner.Executable, "-c", "features.code_mode_host=true", "app-server", "--listen", owner.Endpoint });
                WriteOwnerReceipt(json, directory, owner, host.childPid, host.childStartedAt, null);
                host.WaitForStop();
                uint exitCode;
                if (!GetExitCodeProcess(host.process, out exitCode)) throw Failure("read native exit code");
                host.Stop();
                WriteOwnerReceipt(json, directory, owner, host.childPid, host.childStartedAt, exitCode);
                return unchecked((int)exitCode);
            }
        }
        catch (Exception error)
        {
            Report(error is InvalidOperationException ? error.Message : "WebSocket owner failed");
            return 1;
        }
    }

    private static string Hash(string file)
    {
        using (var hash = SHA256.Create()) using (var input = File.OpenRead(file))
            return BitConverter.ToString(hash.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
    }

    private static bool SamePath(string first, string second)
    {
        return String.Equals(Path.GetFullPath(first).TrimEnd('\\'), Path.GetFullPath(second).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
    }

    private static WebSocketOwner ReadUpdatePredecessor(string directory, string cache, string currentDirectory)
    {
        if (String.IsNullOrEmpty(directory) || !Path.IsPathRooted(directory) || !SamePath(Path.GetDirectoryName(directory), cache) ||
            !Regex.IsMatch(Path.GetFileName(directory), "^[a-f0-9]{64}$") || SamePath(directory, currentDirectory))
            throw new InvalidOperationException("update predecessor directory changed");
        RequirePrivateDirectory(directory);
        string file = Path.Combine(directory, "owner.json");
        if (new FileInfo(file).Length > 65536) throw new InvalidOperationException("update predecessor marker is too large");
        string marker = File.ReadAllText(file);
        using (var hash = SHA256.Create())
            if (BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(marker))).Replace("-", "").ToLowerInvariant() != Path.GetFileName(directory))
                throw new InvalidOperationException("update predecessor marker changed");
        WebSocketOwner previous = new JavaScriptSerializer().Deserialize<WebSocketOwner>(marker);
        if (previous == null || previous.Version != 1 || !Regex.IsMatch(previous.HostSha256 ?? "", "^[a-f0-9]{64}$") ||
            !Regex.IsMatch(previous.ExecutableSha256 ?? "", "^[a-f0-9]{64}$") || !Path.IsPathRooted(previous.Executable ?? "") ||
            Hash(Path.Combine(directory, "Rele.Process.exe")) != previous.HostSha256)
            throw new InvalidOperationException("update predecessor host changed");
        return previous;
    }

    private static FileStream LockUpdatePredecessor(string directory, WebSocketOwner owner)
    {
        if (String.IsNullOrEmpty(owner.UpdatePredecessorDirectory) && String.IsNullOrEmpty(owner.PreviousScheduledDirectory)) return null;
        string cache = Path.GetDirectoryName(directory); RequirePrivateDirectory(cache);
        WebSocketOwner previous = ReadUpdatePredecessor(owner.UpdatePredecessorDirectory, cache, directory);
        WebSocketOwner scheduledBefore = ReadUpdatePredecessor(owner.PreviousScheduledDirectory, cache, directory);
        if (previous.OwnerSid != owner.OwnerSid || previous.TaskName != owner.TaskName || previous.Endpoint != owner.Endpoint ||
            !SamePath(previous.CodexHome, owner.CodexHome) || scheduledBefore.OwnerSid != previous.OwnerSid ||
            scheduledBefore.TaskName != previous.TaskName || scheduledBefore.Endpoint != previous.Endpoint ||
            !SamePath(scheduledBefore.CodexHome, previous.CodexHome) || !SamePath(scheduledBefore.Executable, previous.Executable) ||
            scheduledBefore.ExecutableSha256 != previous.ExecutableSha256)
            throw new InvalidOperationException("update successor installation or profile changed");
        string file = Path.Combine(owner.UpdatePredecessorDirectory, "owner.lock");
        if (File.Exists(file) && (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidOperationException("predecessor lock is redirected");
        var operation = new FileStream(file, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        try { RequirePredecessorExited(owner.UpdatePredecessorDirectory, previous); return operation; }
        catch { operation.Dispose(); throw; }
    }

    private static void RequirePredecessorExited(string directory, WebSocketOwner previous)
    {
        string file = Path.Combine(directory, "receipt.json");
        if (!File.Exists(file) || new FileInfo(file).Length > 65536 || (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidOperationException("predecessor receipt unavailable");
        var receipt = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(file));
        if ((string)receipt["ownerSid"] != previous.OwnerSid || (string)receipt["endpoint"] != previous.Endpoint ||
            !SamePath((string)receipt["codexHome"], previous.CodexHome) || !SamePath((string)receipt["executable"], previous.Executable) ||
            (string)receipt["executableSha256"] != previous.ExecutableSha256)
            throw new InvalidOperationException("predecessor receipt changed");
        foreach (string kind in new[] { "host", "native" })
        {
            int pid = Convert.ToInt32(receipt[kind + "Pid"]); DateTime expected;
            if (pid <= 0 || !DateTime.TryParse((string)receipt[kind + "StartedAt"], System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.RoundtripKind, out expected))
                throw new InvalidOperationException("predecessor process identity unavailable");
            Process process;
            try { process = Process.GetProcessById(pid); }
            catch (ArgumentException) { continue; }
            using (process)
                if (process.StartTime.ToUniversalTime().Ticks == expected.ToUniversalTime().Ticks)
                    throw new InvalidOperationException("predecessor process is still alive");
        }
    }

    // Codex grants its local sandbox users read/execute on the native server's startup directory.
    private static bool IsCodexSandboxReadRule(System.Security.AccessControl.FileSystemAccessRule rule)
    {
        if (rule.AccessControlType != System.Security.AccessControl.AccessControlType.Allow || rule.IsInherited ||
            rule.FileSystemRights != (System.Security.AccessControl.FileSystemRights.ReadAndExecute | System.Security.AccessControl.FileSystemRights.Synchronize) ||
            rule.InheritanceFlags != (System.Security.AccessControl.InheritanceFlags.ContainerInherit | System.Security.AccessControl.InheritanceFlags.ObjectInherit) ||
            rule.PropagationFlags != System.Security.AccessControl.PropagationFlags.None) return false;
        try
        {
            var sandbox = new NTAccount(Environment.MachineName, "CodexSandboxUsers").Translate(typeof(SecurityIdentifier));
            return rule.IdentityReference.Equals(sandbox);
        }
        catch (IdentityNotMappedException) { return false; }
    }

    private static void RequirePrivateDirectory(string directory)
    {
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("owner directory is redirected");
        var security = Directory.GetAccessControl(directory);
        SecurityIdentifier sid = WindowsIdentity.GetCurrent().User;
        if (!security.GetOwner(typeof(SecurityIdentifier)).Equals(sid) || !security.AreAccessRulesProtected)
            throw new InvalidOperationException("owner directory is not private");
        foreach (System.Security.AccessControl.FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            if (rule.AccessControlType == System.Security.AccessControl.AccessControlType.Allow && !rule.IdentityReference.Equals(sid) && !IsCodexSandboxReadRule(rule))
                throw new InvalidOperationException("owner directory has a foreign access grant");
    }

    private static void WriteOwnerReceipt(JavaScriptSerializer json, string directory, WebSocketOwner owner, uint pid, string startedAt, uint? exitCode)
    {
        var receipt = new Dictionary<string, object> {
            { "ownerSid", owner.OwnerSid }, { "endpoint", owner.Endpoint }, { "codexHome", owner.CodexHome },
            { "executable", owner.Executable }, { "executableSha256", owner.ExecutableSha256 },
            { "hostPid", Process.GetCurrentProcess().Id }, { "nativePid", pid }, { "exitCode", exitCode },
            { "status", exitCode.HasValue ? "exited" : "running" }
        };
        receipt.Add("hostStartedAt", Process.GetCurrentProcess().StartTime.ToUniversalTime().ToString("o"));
        receipt.Add("nativeStartedAt", startedAt);
        string path = Path.Combine(directory, "receipt.json"), temporary = path + ".new";
        File.WriteAllText(temporary, json.Serialize(receipt), new UTF8Encoding(false));
        if (File.Exists(path)) File.Replace(temporary, path, null); else File.Move(temporary, path);
    }

    private void Start(string[] args)
    {
        job = CreateJobObject(IntPtr.Zero, null); // Unnamed and non-inheritable: only this host owns its lifetime.
        if (job == IntPtr.Zero) throw Failure("create private job");
        var limits = new ExtendedLimits();
        limits.Basic.Flags = KillOnJobClose; // Deliberately no breakaway flags.
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
            throw Failure("configure private job");

        var attributes = new SecurityAttributes();
        attributes.Length = Marshal.SizeOf(typeof(SecurityAttributes));
        attributes.InheritHandle = true;
        IntPtr inputRead = IntPtr.Zero;
        IntPtr inputWrite = IntPtr.Zero;
        IntPtr output = IntPtr.Zero;
        IntPtr errorOutput = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr handleList = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        bool attributeListInitialized = false;
        try
        {
            if (websocketOwner)
            {
                inputRead = NullHandle(ref attributes, 0x80000000);
                output = NullHandle(ref attributes, 0x40000000);
                errorOutput = NullHandle(ref attributes, 0x40000000);
            }
            else
            {
                if (!CreatePipe(out inputRead, out inputWrite, ref attributes, 0)) throw Failure("create child input pipe");
                childInput = new SafeFileHandle(inputWrite, true);
                inputWrite = IntPtr.Zero;
                if (!SetHandleInformation(childInput, 1, 0)) throw Failure("protect child input writer");
                output = InheritableStandardHandle(-11);
                errorOutput = InheritableStandardHandle(-12);
            }

            UIntPtr attributeSize = UIntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
            if (attributeSize == UIntPtr.Zero) throw Failure("size inherited handle list");
            attributeList = Marshal.AllocHGlobal(checked((int)attributeSize.ToUInt64()));
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeSize))
                throw Failure("initialize inherited handle list");
            attributeListInitialized = true;
            handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handleList, 0, inputRead);
            Marshal.WriteIntPtr(handleList, IntPtr.Size, output);
            Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, errorOutput);
            if (!UpdateProcThreadAttribute(attributeList, 0, new UIntPtr(0x00020002), handleList,
                new UIntPtr((uint)(IntPtr.Size * 3)), IntPtr.Zero, IntPtr.Zero))
                throw Failure("set inherited handle list");

            var startup = new StartupInfoEx();
            startup.Startup.Size = Marshal.SizeOf(typeof(StartupInfoEx));
            startup.Startup.Flags = 0x100; // STARTF_USESTDHANDLES
            startup.Startup.Input = inputRead;
            startup.Startup.Output = output;
            startup.Startup.Error = errorOutput;
            startup.AttributeList = attributeList;
            var commandLine = new StringBuilder();
            for (int index = 1; index < args.Length; index++)
            {
                if (index > 1) commandLine.Append(' ');
                commandLine.Append(Quote(args[index]));
            }
            if (commandLine.Length >= 32767) throw new InvalidOperationException("child command line is too long");
            ProcessInformation created;
            // Only the independent native child receives the stable relay address; Desktop and this owner keep their environment.
            if (websocketOwner) environment = NativeEnvironment(desktopTools == null ? null : desktopTools.PipePath);
            if (!CreateProcess(null, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                CreateSuspended | ExtendedStartupInfoPresent | CreateNoWindow | (environment == IntPtr.Zero ? 0u : 0x400u), environment, null, ref startup, out created))
                throw Failure("create suspended child");
            process = created.Process;
            primaryThread = created.Thread;
            childPid = created.ProcessId;
            using (Process child = Process.GetProcessById(checked((int)childPid))) childStartedAt = child.StartTime.ToUniversalTime().ToString("o");
            if (!AssignProcessToJobObject(job, process)) throw Failure("assign suspended child to private job");
            assigned = true;
            if (ResumeThread(primaryThread) == UInt32.MaxValue) throw Failure("resume guarded child");
            Close(ref primaryThread);
        }
        finally
        {
            if (attributeListInitialized) DeleteProcThreadAttributeList(attributeList);
            if (attributeList != IntPtr.Zero) Marshal.FreeHGlobal(attributeList);
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            Close(ref inputRead);
            Close(ref inputWrite);
            Close(ref output);
            Close(ref errorOutput);
        }

        if (websocketOwner) return; // Scheduler stdin is NUL; EOF must not terminate a WebSocket server.
        var relay = new Thread(RelayInput);
        relay.IsBackground = true;
        relay.Start();
    }

    private static IntPtr NullHandle(ref SecurityAttributes attributes, uint access)
    {
        IntPtr handle = CreateFile("NUL", access, 3, ref attributes, 3, 0, IntPtr.Zero);
        if (handle == new IntPtr(-1)) throw Failure("open explicit NUL handle");
        return handle;
    }

    private void RelayInput()
    {
        try
        {
            var buffer = new byte[65536];
            IntPtr input = GetStdHandle(-10);
            while (!stopRequested.WaitOne(0))
            {
                uint count;
                if (!ReadFile(input, buffer, (uint)buffer.Length, out count, IntPtr.Zero))
                {
                    int error = Marshal.GetLastWin32Error();
                    if (error != 109 && error != 38) relayFailure = "read host input failed (Windows error " + error + ")";
                    break;
                }
                if (count == 0) break;
                while (count > 0 && !stopRequested.WaitOne(0))
                {
                    uint written;
                    if (!WriteFile(childInput, buffer, count, out written, IntPtr.Zero))
                    {
                        int error = Marshal.GetLastWin32Error();
                        if (error != 109 && error != 232) relayFailure = "write child input failed (Windows error " + error + ")";
                        return;
                    }
                    if (written == 0) { relayFailure = "child input made no progress"; return; }
                    count -= written;
                    if (count > 0) Array.Copy(buffer, (int)written, buffer, 0, (int)count);
                }
            }
        }
        catch { relayFailure = "input relay failed"; }
        finally
        {
            // EOF is control for the host. Keep the child's input open until its Job is terminated.
            stopRequested.Set();
        }
    }

    private void WaitForStop()
    {
        var handles = new[] { process, stopRequested.SafeWaitHandle.DangerousGetHandle() };
        uint result = WaitForMultipleObjects((uint)handles.Length, handles, false, UInt32.MaxValue);
        if (result != WaitObject0 && result != WaitObject0 + 1) throw Failure("wait for child or input closure");
    }

    private void Stop()
    {
        if (stopped) return;
        stopAttempted = true;
        var timer = Stopwatch.StartNew();
        stopRequested.Set();
        if (assigned)
        {
            // Also runs after a natural root exit, while its background descendants may still be alive.
            if (!TerminateJobObject(job, 1)) throw Failure("terminate private job");
        }
        else if (process != IntPtr.Zero && !TerminateProcess(process, 1))
            throw Failure("terminate unassigned suspended child");

        if (process != IntPtr.Zero)
        {
            uint result = WaitForSingleObject(process, Remaining(timer));
            if (result == WaitTimeout) throw new InvalidOperationException("guarded child shutdown timed out");
            if (result != WaitObject0) throw Failure("wait for guarded child shutdown");
        }
        // Accounting retains a terminated process until references are released. Close our own handles first.
        Close(ref primaryThread);
        Close(ref process);
        if (job != IntPtr.Zero)
        {
            while (true)
            {
                BasicAccounting accounting;
                if (!QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(BasicAccounting)), IntPtr.Zero))
                    throw Failure("verify private job is empty");
                if (accounting.ActiveProcesses == 0) break;
                if (Remaining(timer) == 0) throw new InvalidOperationException("private job shutdown timed out");
                Thread.Sleep(20);
            }
        }
        stopped = true;
    }

    private static uint Remaining(Stopwatch timer)
    {
        return (uint)Math.Max(0, ShutdownMilliseconds - timer.ElapsedMilliseconds);
    }

    public void Dispose()
    {
        if (!stopped && !stopAttempted)
        {
            try { Stop(); }
            catch { /* Closing the private Job remains the final fail-closed kill, never a successful stop. */ }
        }
        Close(ref primaryThread);
        Close(ref process);
        Close(ref job);
        if (childInput != null) childInput.Dispose();
        if (desktopTools != null) desktopTools.Dispose();
        // A background relay may be blocked reading the parent's pipe. Process exit closes it without waiting.
    }

    private bool IsNativeChild(SafeFileHandle candidate)
    {
        bool member;
        return job != IntPtr.Zero && IsProcessInJob(candidate, job, out member) && member;
    }

    private static IntPtr NativeEnvironment(string pipe)
    {
        var values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables()) values[(string)entry.Key] = (string)entry.Value;
        values.Remove("CODEX_APP_TOOLS_PIPE_PATH");
        if (pipe != null) values.Add("CODEX_APP_TOOLS_PIPE_PATH", pipe);
        var block = new StringBuilder();
        foreach (var entry in values) block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');
        block.Append('\0');
        return Marshal.StringToHGlobalUni(block.ToString());
    }

    private static IntPtr InheritableStandardHandle(int kind)
    {
        IntPtr result;
        if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(kind), GetCurrentProcess(), out result, 0, true, 2))
            throw Failure("duplicate standard output handle");
        return result;
    }

    internal static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') result.Append('\\', slashes * 2 + 1);
            else result.Append('\\', slashes);
            result.Append(character);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    private static InvalidOperationException Failure(string operation)
    {
        return new InvalidOperationException(operation + " failed (Windows error " + Marshal.GetLastWin32Error() + ")");
    }

    private static void Report(string message)
    {
        try { Console.Error.WriteLine("Rele process host: " + message + "."); } catch { }
    }

    private static void Close(ref IntPtr handle)
    {
        if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
    }

    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes
    {
        public int Length;
        public IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo
    {
        public int Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        public ushort ShowWindow, ReservedSize;
        public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] private struct StartupInfoEx
    {
        public StartupInfo Startup;
        public IntPtr AttributeList;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInformation
    {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits
    {
        public long PerProcessUserTime, PerJobUserTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters
    {
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] private struct BasicAccounting
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(SafeFileHandle process, IntPtr job, out bool member);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(IntPtr job, int type, out BasicAccounting info, uint size, IntPtr returnedLength);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetHandleInformation(SafeFileHandle handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, uint count, uint flags, ref UIntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInformation information);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool ReadFile(IntPtr file, byte[] buffer, uint count, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool WriteFile(SafeFileHandle file, byte[] buffer, uint count, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateFile(string path, uint access, uint share, ref SecurityAttributes attributes, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
}
