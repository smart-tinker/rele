using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class Rele
{
    public sealed class Settings
    {
        public string DataDirectory { get; set; }
        public string TaskName { get; set; }
        public int Port { get; set; }
        public string CodexHome { get; set; }
    }

    private sealed class LegacyStartup
    {
        public string File;
        public byte[] Contents;
        public string CodexHome;
    }

    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly object LogLock = new object();
    private static string AppDirectory;
    private static Settings Config;

    [STAThread]
    private static int Main(string[] args)
    {
        string command = args.Length == 0 ? "open" : args[0];
        var options = new Dictionary<string, string>(StringComparer.Ordinal);
        try
        {
            for (int i = 1; i < args.Length; i++)
            {
                if (args[i] == "--quiet" || args[i] == "--backup") options.Add(args[i], "true");
                else if (Array.IndexOf(new[] { "--app-dir", "--data-dir", "--task-name", "--port", "--codex-home", "--error-file" }, args[i]) >= 0 && i + 1 < args.Length)
                    options.Add(args[i], args[++i]);
                else throw new InvalidOperationException("Неизвестный параметр Rele.");
            }
            SecurityIdentifier currentUser = WindowsIdentity.GetCurrent().User;
            if (currentUser.IsWellKnown(WellKnownSidType.LocalSystemSid) || currentUser.IsWellKnown(WellKnownSidType.LocalServiceSid) || currentUser.IsWellKnown(WellKnownSidType.NetworkServiceSid))
                throw new InvalidOperationException("Установите и запускайте Rele из обычной учётной записи владельца Codex, а не SYSTEM или служебной учётной записи Windows.");
            AppDirectory = Path.GetFullPath(Value(options, "--app-dir", AppDomain.CurrentDomain.BaseDirectory));
            string settingsPath = Path.Combine(AppDirectory, "rele-install.json");
            Config = File.Exists(settingsPath) ? Json.Deserialize<Settings>(File.ReadAllText(settingsPath)) : new Settings
            {
                DataDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Rele"),
                TaskName = "Rele-" + WindowsIdentity.GetCurrent().User.Value,
                Port = 3210,
                CodexHome = Environment.GetEnvironmentVariable("CODEX_HOME")
            };
            if (File.Exists(settingsPath) &&
                ((!SamePath(Value(options, "--data-dir", Config.DataDirectory), Config.DataDirectory)) ||
                 Value(options, "--task-name", Config.TaskName) != Config.TaskName))
                throw new InvalidOperationException("Обновление должно использовать прежние каталог данных и фоновую задачу Rele.");
            Config.DataDirectory = Path.GetFullPath(Value(options, "--data-dir", Config.DataDirectory));
            Config.TaskName = Value(options, "--task-name", Config.TaskName);
            Config.CodexHome = Value(options, "--codex-home", Config.CodexHome);
            Config.Port = Int32.Parse(Value(options, "--port", Config.Port.ToString()));
            if (!Regex.IsMatch(Config.TaskName, @"^Rele-[A-Za-z0-9._-]{1,120}$") || Config.Port < 0 || Config.Port > 65535)
                throw new InvalidOperationException("Недопустимое имя задачи или локальный порт Rele.");
            if (SamePath(Config.DataDirectory, AppDirectory) || Config.DataDirectory.StartsWith(AppDirectory.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Каталог данных должен находиться вне каталога программы, чтобы удаление Rele сохранило данные.");

            if (command == "serve") return RunNode("serve", true);
            if (command == "prepare-update")
            {
                ReadLegacyStartup();
                Stop(true);
                try { Backup(); }
                catch { SetTaskEnabled(true); throw; }
                return 0;
            }
            if (command == "install")
            {
                LegacyStartup legacy = ReadLegacyStartup();
                if (!File.Exists(settingsPath) && !options.ContainsKey("--codex-home") && legacy != null && legacy.CodexHome != null)
                    Config.CodexHome = legacy.CodexHome;
                Directory.CreateDirectory(AppDirectory);
                File.WriteAllText(settingsPath, Json.Serialize(Config), new UTF8Encoding(false));
                if (options.ContainsKey("--backup")) Backup();
                RegisterTask();
                Start();
                MigrateLegacyStartup(legacy);
                return 0;
            }
            if (command == "uninstall")
            {
                Stop(true);
                dynamic folder = TaskFolder();
                if (OwnedTask(folder) != null) folder.DeleteTask(Config.TaskName, 0);
                return 0;
            }
            if (command == "stop") { Stop(false); return 0; }
            if (command == "restart") Stop(false);
            else if (command != "open" && command != "start") throw new InvalidOperationException("Неизвестная команда Rele.");
            Start();
            if (command != "start" && !options.ContainsKey("--quiet")) return RunNode("open", false);
            return 0;
        }
        catch (Exception error)
        {
            string message = "Rele: " + error.Message;
            if (options.ContainsKey("--error-file"))
            {
                try { File.WriteAllText(options["--error-file"], message, new UTF8Encoding(false)); } catch { }
            }
            if (command == "serve") Log(message);
            else if (!options.ContainsKey("--quiet")) MessageBox.Show(message, "Rele", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static string Value(Dictionary<string, string> options, string key, string fallback)
    {
        string value;
        return options.TryGetValue(key, out value) ? value : fallback;
    }

    private static bool SamePath(string first, string second)
    {
        return String.Equals(Path.GetFullPath(first).TrimEnd('\\'), Path.GetFullPath(second).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
    }

    private static dynamic TaskFolder()
    {
        dynamic scheduler = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service", true));
        scheduler.Connect();
        return scheduler.GetFolder("\\");
    }

    private static dynamic OwnedTask(dynamic folder)
    {
        dynamic task;
        try { task = folder.GetTask(Config.TaskName); }
        catch (COMException error)
        {
            if (error.ErrorCode == unchecked((int)0x80070002)) return null;
            throw;
        }
        dynamic definition = task.Definition;
        if (definition.Actions.Count != 1 || definition.Actions[1].Type != 0 ||
            !SamePath((string)definition.Actions[1].Path, Path.Combine(AppDirectory, "Rele.exe")) ||
            (string)definition.Actions[1].Arguments != "serve" ||
            !IsCurrentUser((string)definition.Principal.UserId) ||
            (int)definition.Principal.LogonType != 3 || (int)definition.Principal.RunLevel != 0)
            throw new InvalidOperationException("Задача с этим именем принадлежит другой установке. Rele не будет её изменять.");
        return task;
    }

    private static bool IsCurrentUser(string user)
    {
        try
        {
            SecurityIdentifier sid = user.StartsWith("S-1-", StringComparison.OrdinalIgnoreCase) ? new SecurityIdentifier(user) :
                (SecurityIdentifier)new NTAccount(user).Translate(typeof(SecurityIdentifier));
            return sid.Equals(WindowsIdentity.GetCurrent().User);
        }
        catch { return false; }
    }

    private static void RegisterTask()
    {
        dynamic folder = TaskFolder();
        OwnedTask(folder);
        string user = SecurityElement.Escape(WindowsIdentity.GetCurrent().User.Value);
        string executable = SecurityElement.Escape(Path.Combine(AppDirectory, "Rele.exe"));
        string directory = SecurityElement.Escape(AppDirectory);
        string xml = "<?xml version=\"1.0\" encoding=\"UTF-16\"?>" +
            "<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">" +
            "<RegistrationInfo><Description>Rele: gateway текущего пользователя. Данные сохраняются при удалении программы.</Description></RegistrationInfo>" +
            "<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>" + user + "</UserId></LogonTrigger></Triggers>" +
            "<Principals><Principal id=\"User\"><UserId>" + user + "</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>" +
            "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>" +
            "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled>" +
            "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>" +
            "<Actions Context=\"User\"><Exec><Command>" + executable + "</Command><Arguments>serve</Arguments><WorkingDirectory>" + directory + "</WorkingDirectory></Exec></Actions></Task>";
        folder.RegisterTask(Config.TaskName, xml, 6, WindowsIdentity.GetCurrent().User.Value, null, 3, null);
    }

    private static void SetTaskEnabled(bool enabled)
    {
        dynamic task = OwnedTask(TaskFolder());
        if (task != null) task.Enabled = enabled;
    }

    private static void Start()
    {
        dynamic task = OwnedTask(TaskFolder());
        if (task == null) throw new InvalidOperationException("Фоновый запуск ещё не установлен. Запустите установщик Rele. Для portable-режима используйте start-rele.");
        task.Enabled = true;
        task.Run(null);
        RunNode("status --wait", false);
    }

    private static bool TaskActive(dynamic task)
    {
        return task != null && ((int)task.State == 2 || (int)task.GetInstances(0).Count > 0);
    }

    private static Process OwnInstance()
    {
        string file = Path.Combine(Config.DataDirectory, "instance.json");
        if (!File.Exists(file)) return null;
        Dictionary<string, object> instance;
        try { instance = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(file)); }
        catch { throw new InvalidOperationException("Не удалось прочитать состояние Rele. Повторите попытку после завершения запуска."); }
        if (!instance.ContainsKey("pid")) throw new InvalidOperationException("Состояние Rele не содержит PID; остановите запущенный экземпляр вручную.");
        Process process;
        try { process = Process.GetProcessById(Convert.ToInt32(instance["pid"])); }
        catch (ArgumentException) { return null; }
        string executable;
        try { executable = process.MainModule.FileName; }
        catch { process.Dispose(); throw new InvalidOperationException("Не удалось проверить владельца процесса Rele; автоматическая остановка отменена."); }
        if (!SamePath(executable, Path.Combine(AppDirectory, "runtime", "node.exe")))
        {
            process.Dispose();
            throw new InvalidOperationException("Rele с этим каталогом данных запущен из другой папки (например, старого ZIP). Остановите его в прежнем окне через Ctrl+C и повторите установку. Другие процессы не остановлены.");
        }
        return process;
    }

    private static void Stop(bool leaveDisabled)
    {
        dynamic task = OwnedTask(TaskFolder());
        bool enabled = task != null && (bool)task.Enabled;
        if (task != null) task.Enabled = false;
        try
        {
            // A newly started task can precede instance.json. Do not replace its files in that interval.
            for (int i = 0; TaskActive(task) && !File.Exists(Path.Combine(Config.DataDirectory, "instance.json")) && i < 150; i++) Thread.Sleep(100);
            using (Process instance = OwnInstance())
            {
                if (instance != null)
                {
                    RunNode("stop", false);
                    if (!instance.WaitForExit(30000)) throw new InvalidOperationException("Rele не завершился за 30 секунд. Установка не будет заменять занятые файлы.");
                }
            }
            for (int i = 0; TaskActive(task) && i < 150; i++) Thread.Sleep(100);
            if (TaskActive(task)) throw new InvalidOperationException("Фоновая задача Rele ещё работает. Остановите её штатно и повторите попытку.");
            if (task != null && !leaveDisabled) task.Enabled = enabled;
        }
        catch { if (task != null) task.Enabled = enabled; throw; }
    }

    private static void Backup()
    {
        if (File.Exists(Path.Combine(Config.DataDirectory, "rele.sqlite")) && File.Exists(Path.Combine(AppDirectory, "dist", "server", "main.js")))
            RunNode("backup", false);
    }

    private static InvalidOperationException UnknownStartup()
    {
        return new InvalidOperationException("В автозагрузке найден Rele.cmd, который нельзя безопасно перенести или который использует другой каталог данных. Файл не изменён. Отключите этот старый автозапуск вручную и повторите установку.");
    }

    private static string DecodeCmdLiteral(string value)
    {
        if (value.Replace("%%", "").Contains("%")) throw UnknownStartup();
        return value.Replace("%%", "%");
    }

    private static string CmdLiteral(string value) { return value.Replace("%", "%%"); }

    private static LegacyStartup ReadLegacyStartup()
    {
        string file = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "Rele.cmd");
        if (!File.Exists(file)) return null;
        try
        {
            if (new FileInfo(file).Length > 16384) throw UnknownStartup();
            byte[] bytes = File.ReadAllBytes(file);
            string source = new UTF8Encoding(false, true).GetString(bytes);
            string[] lines = source.Split(new[] { "\r\n" }, StringSplitOptions.None);
            if (lines.Length < 6 || lines[0] != "@echo off" || lines[1] != "chcp 65001 >nul" || lines[2] != "setlocal DisableDelayedExpansion") throw UnknownStartup();
            var variables = new Dictionary<string, string>();
            int index = 3;
            while (index < lines.Length && lines[index].StartsWith("set ", StringComparison.Ordinal))
            {
                Match variable = Regex.Match(lines[index++], "^set \"(CODEX_HOME|RELE_DATA_DIR)=([^\"]+)\"$");
                if (!variable.Success) throw UnknownStartup();
                variables.Add(variable.Groups[1].Value, DecodeCmdLiteral(variable.Groups[2].Value));
            }
            if (index + 3 != lines.Length) throw UnknownStartup();
            Match directory = Regex.Match(lines[index], "^cd /d \"([^\"]+)\"$");
            if (!directory.Success) throw UnknownStartup();
            string oldRoot = DecodeCmdLiteral(directory.Groups[1].Value);
            if (!Path.IsPathRooted(oldRoot)) throw UnknownStartup();
            string node = Path.Combine(oldRoot, "runtime", "node.exe");
            string main = Path.Combine(oldRoot, "dist", "server", "main.js");
            var expected = new List<string> { "@echo off", "chcp 65001 >nul", "setlocal DisableDelayedExpansion" };
            foreach (string key in new[] { "CODEX_HOME", "RELE_DATA_DIR" })
                if (variables.ContainsKey(key)) expected.Add("set \"" + key + "=" + CmdLiteral(variables[key]) + "\"");
            expected.Add("cd /d \"" + CmdLiteral(oldRoot) + "\"");
            expected.Add("start \"Rele\" /min \"" + CmdLiteral(node) + "\" \"" + CmdLiteral(main) + "\"");
            expected.Add("");
            if (String.Join("\r\n", expected) != source || !File.Exists(node) || !File.Exists(main)) throw UnknownStartup();
            var package = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(oldRoot, "package.json")));
            if (!package.ContainsKey("name") || (string)package["name"] != "rele") throw UnknownStartup();
            string oldData = variables.ContainsKey("RELE_DATA_DIR") ? Path.GetFullPath(Path.Combine(oldRoot, variables["RELE_DATA_DIR"])) :
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Rele");
            if (!SamePath(oldData, Config.DataDirectory)) throw UnknownStartup();
            return new LegacyStartup { File = file, Contents = bytes, CodexHome = variables.ContainsKey("CODEX_HOME") ? Path.GetFullPath(Path.Combine(oldRoot, variables["CODEX_HOME"])) : null };
        }
        catch { throw UnknownStartup(); }
    }

    private static void MigrateLegacyStartup(LegacyStartup legacy)
    {
        if (legacy == null) return;
        string directory = Path.Combine(Config.DataDirectory, "backups", "legacy-startup-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff"));
        Directory.CreateDirectory(directory);
        File.WriteAllBytes(Path.Combine(directory, "Rele.cmd"), legacy.Contents);
        if (Convert.ToBase64String(File.ReadAllBytes(legacy.File)) != Convert.ToBase64String(legacy.Contents)) throw UnknownStartup();
        File.Delete(legacy.File);
    }

    private static int RunNode(string command, bool background)
    {
        var start = new ProcessStartInfo(Path.Combine(AppDirectory, "runtime", "node.exe"), "\"" + Path.Combine(AppDirectory, "dist", "server", "main.js") + "\" " + command)
        {
            WorkingDirectory = AppDirectory, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        start.EnvironmentVariables["RELE_DATA_DIR"] = Config.DataDirectory;
        start.EnvironmentVariables["RELE_PORT"] = Config.Port.ToString();
        if (!String.IsNullOrEmpty(Config.CodexHome)) start.EnvironmentVariables["CODEX_HOME"] = Config.CodexHome;
        var errors = new StringBuilder();
        using (var process = new Process { StartInfo = start })
        {
            process.OutputDataReceived += (sender, line) => { if (background && line.Data != null) Log(line.Data); };
            process.ErrorDataReceived += (sender, line) =>
            {
                if (line.Data == null) return;
                if (background) Log(line.Data);
                else lock (errors) { if (errors.Length < 4000) errors.AppendLine(line.Data); }
            };
            process.Start();
            using (var job = background ? new ChildJob(process) : null)
            {
                process.BeginOutputReadLine(); process.BeginErrorReadLine();
                if (background) process.WaitForExit();
                else if (!process.WaitForExit(60000))
                {
                    try { if (!process.HasExited) process.Kill(); } catch { }
                    throw new InvalidOperationException("Команда Rele не завершилась за 60 секунд.");
                }
                process.WaitForExit();
                if (!background && process.ExitCode != 0)
                    throw new InvalidOperationException(errors.Length == 0 ? "Команда Rele завершилась с ошибкой." : errors.ToString().Trim());
                return process.ExitCode;
            }
        }
    }

    private static void Log(string message)
    {
        if (Config == null) return;
        try
        {
            lock (LogLock)
            {
                string directory = Path.Combine(Config.DataDirectory, "logs");
                Directory.CreateDirectory(directory);
                string file = Path.Combine(directory, "service.log");
                if (File.Exists(file) && new FileInfo(file).Length > 1024 * 1024)
                {
                    string previous = file + ".1";
                    if (File.Exists(previous)) File.Delete(previous);
                    File.Move(file, previous);
                }
                File.AppendAllText(file, DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine, new UTF8Encoding(false));
            }
        }
        catch { }
    }

    // Closing this wrapper's job also closes only its own Node/proxy children after a hard task stop.
    private sealed class ChildJob : IDisposable
    {
        [StructLayout(LayoutKind.Sequential)] private struct BasicLimits
        {
            public long ProcessTime, JobTime;
            public uint Flags;
            public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
            public uint ActiveProcesses;
            public UIntPtr Affinity;
            public uint Priority, Scheduling;
        }
        [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadCount, WriteCount, OtherCount, ReadBytes, WriteBytes, OtherBytes; }
        [StructLayout(LayoutKind.Sequential)] private struct Limits
        {
            public BasicLimits Basic;
            public IoCounters Io;
            public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int type, ref Limits info, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
        private IntPtr handle;

        public ChildJob(Process process)
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            var limits = new Limits(); limits.Basic.Flags = 0x2000;
            if (handle == IntPtr.Zero || !SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf(typeof(Limits))) || !AssignProcessToJobObject(handle, process.Handle))
            {
                try { if (!process.HasExited) process.Kill(); } catch { }
                Dispose();
                throw new InvalidOperationException("Windows не разрешила безопасно управлять дочерним процессом Rele.");
            }
        }
        public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
    }
}
