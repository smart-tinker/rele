using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Principal;
using System.Security.Cryptography;
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
        public string OwnerSid { get; set; }
        public bool DesktopIntegrationOwned { get; set; }
        public bool? DesktopIntegrationRequested { get; set; }
        public string PreviousCodexCliPath { get; set; }
        public string PreviousForceCli { get; set; }
        public string DesktopIntegrationWarning { get; set; }
        public string DesktopCliPath { get; set; }
        public string PreviousCodexWebSocketUrl { get; set; }
        public string InstalledCodexWebSocketUrl { get; set; }
        public string CodexWebSocketEndpoint { get; set; }
        public string CodexWebSocketOwnerDirectory { get; set; }
        public string CodexWebSocketTaskName { get; set; }
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
            if (command == "codex-start" || command == "codex-status")
            {
                // This GUI launcher has redirected pipes, not an attached console/code page.
                Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
                Console.SetError(new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true });
            }
            for (int i = 1; i < args.Length; i++)
            {
                if (args[i] == "--quiet" || args[i] == "--backup" || args[i] == "--desktop-integration" || args[i] == "--prepare-codex" || args[i] == "--preserve-active" || args[i] == "--retry-desktop-integration") options.Add(args[i], "true");
                else if (Array.IndexOf(new[] { "--app-dir", "--data-dir", "--task-name", "--port", "--codex-home", "--codex-executable", "--error-file", "--warning-file", "--path-file" }, args[i]) >= 0 && i + 1 < args.Length)
                    options.Add(args[i], args[++i]);
                else throw new InvalidOperationException("Неизвестный параметр Rele.");
            }
            if (options.ContainsKey("--retry-desktop-integration") && command != "desktop-integrate")
                throw new InvalidOperationException("Повтор подключения Desktop допустим только для desktop-integrate.");
            SecurityIdentifier currentUser = WindowsIdentity.GetCurrent().User;
            if (currentUser.IsWellKnown(WellKnownSidType.LocalSystemSid) || currentUser.IsWellKnown(WellKnownSidType.LocalServiceSid) || currentUser.IsWellKnown(WellKnownSidType.NetworkServiceSid))
                throw new InvalidOperationException("Установите и запускайте Rele из обычной учётной записи владельца Codex, а не SYSTEM или служебной учётной записи Windows.");
            AppDirectory = Path.GetFullPath(Value(options, "--app-dir", AppDomain.CurrentDomain.BaseDirectory));
            string settingsPath = Path.Combine(AppDirectory, "rele-install.json");
            Config = File.Exists(settingsPath) ? ReadInstallationSettings() : new Settings
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
            if (!String.IsNullOrEmpty(Config.OwnerSid) && Config.OwnerSid != currentUser.Value)
                throw new InvalidOperationException("Эта установка Rele принадлежит другой учётной записи Windows.");
            bool ownedSettings = File.Exists(settingsPath) && Config.OwnerSid == currentUser.Value;
            Config.OwnerSid = currentUser.Value;
            Config.DataDirectory = Path.GetFullPath(Value(options, "--data-dir", Config.DataDirectory));
            Config.TaskName = Value(options, "--task-name", Config.TaskName);
            Config.CodexHome = Value(options, "--codex-home", Config.CodexHome);
            Config.Port = Int32.Parse(Value(options, "--port", Config.Port.ToString()));
            if (!Regex.IsMatch(Config.TaskName, @"^Rele-[A-Za-z0-9._-]{1,120}$") || Config.Port < 0 || Config.Port > 65535)
                throw new InvalidOperationException("Недопустимое имя задачи или локальный порт Rele.");
            if (SamePath(Config.DataDirectory, AppDirectory) || Config.DataDirectory.StartsWith(AppDirectory.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Каталог данных должен находиться вне каталога программы, чтобы удаление Rele сохранило данные.");

            if (command == "desktop-choice")
            {
                if (!options.ContainsKey("--path-file")) throw new InvalidOperationException("Укажите файл результата desktop-choice.");
                string choice = ownedSettings && Config.DesktopIntegrationRequested.HasValue ? (Config.DesktopIntegrationRequested.Value ? "on" : "off") : String.Empty;
                File.WriteAllText(options["--path-file"], choice, new UTF8Encoding(false));
                return 0;
            }
            if (command == "serve") return RunNode("serve", true);
            if (command == "codex-status")
            {
                if (!options.ContainsKey("--codex-home")) throw new InvalidOperationException("Укажите исходный профиль Codex.");
                Console.Out.WriteLine(Json.Serialize(File.Exists(settingsPath) ? CodexWebSocketStatus(options["--codex-home"]) :
                    new Dictionary<string, object> { { "status", "notRunning" } }));
                return 0;
            }
            if (command == "codex-start")
            {
                if (!File.Exists(settingsPath) || !options.ContainsKey("--codex-executable") || !options.ContainsKey("--codex-home"))
                    throw new InvalidOperationException("Запуск общего Codex требует существующую установку, backend и исходный профиль.");
                Console.Out.WriteLine(Json.Serialize(StartCodexWebSocket(options["--codex-executable"], options["--codex-home"], options.ContainsKey("--preserve-active"))));
                return 0;
            }
            if (command == "desktop-check")
            {
                if (!File.Exists(settingsPath) || !options.ContainsKey("--error-file"))
                    throw new InvalidOperationException("Проверка Desktop требует существующую установку и файл результата.");
                RunNode(options.ContainsKey("--prepare-codex") ? "--rele-desktop-setup" : "--rele-desktop-check", false, true);
                // An empty receipt distinguishes successful completion from a task that never ran.
                File.WriteAllText(options["--error-file"], String.Empty, new UTF8Encoding(false));
                return 0;
            }
            if (command == "codex-desktop")
            {
                ValidateDesktopIntegration();
                return RunNode("--rele-desktop", false, true);
            }
            if (command == "desktop-integrate" || command == "desktop-unintegrate")
            {
                if (!File.Exists(settingsPath)) throw new InvalidOperationException("Сначала установите Rele.");
                using (var operation = CodexOperationLock("integration.lock"))
                {
                    ReloadOwnedInstallation(options);
                    if (options.ContainsKey("--retry-desktop-integration") &&
                        (Config.DesktopIntegrationRequested != true || Config.DesktopIntegrationOwned)) return 0;
                    bool enabled = command == "desktop-integrate";
                    try { if (enabled) InstallDesktopIntegration(false); else RemoveDesktopIntegration(); }
                    catch (Exception error) { Config.DesktopIntegrationWarning = error.Message; throw; }
                    finally
                    {
                        Config.DesktopIntegrationRequested = enabled;
                        SaveDesktopSettings();
                    }
                }
                return 0;
            }
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
                Directory.CreateDirectory(AppDirectory);
                using (var operation = CodexOperationLock("integration.lock"))
                {
                    ReloadOwnedInstallation(options, true);
                    if (!File.Exists(settingsPath) && !options.ContainsKey("--codex-home") && legacy != null && legacy.CodexHome != null)
                        Config.CodexHome = legacy.CodexHome;
                    SaveDesktopSettings();
                    if (options.ContainsKey("--backup")) Backup();
                    Config.DesktopIntegrationWarning = null;
                    if (options.ContainsKey("--desktop-integration"))
                    {
                        try { InstallDesktopIntegration(true); }
                        catch (Exception error)
                        {
                            Config.DesktopIntegrationWarning = error.Message;
                            Log("Desktop integration skipped: " + error.Message);
                            if (options.ContainsKey("--warning-file")) File.WriteAllText(options["--warning-file"], error.Message, new UTF8Encoding(false));
                        }
                    }
                    else RemoveDesktopIntegration();
                    Config.DesktopIntegrationRequested = options.ContainsKey("--desktop-integration");
                    SaveDesktopSettings();
                }
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
                using (var operation = CodexOperationLock("integration.lock"))
                {
                    ReloadOwnedInstallation(options);
                    RemoveDesktopIntegration();
                    Config.DesktopIntegrationRequested = false;
                    SaveDesktopSettings();
                    RemoveCodexWebSocketStartup();
                }
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
            else if (command == "codex-start" || command == "codex-status") Console.Error.WriteLine(message);
            else if (!options.ContainsKey("--quiet")) MessageBox.Show(message, "Rele", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static string Value(Dictionary<string, string> options, string key, string fallback)
    {
        string value;
        return options.TryGetValue(key, out value) ? value : fallback;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetLongPathName(string shortPath, StringBuilder longPath, uint bufferLength);

    private static string CanonicalPath(string path)
    {
        string full = Path.GetFullPath(path);
        var buffer = new StringBuilder(260);
        uint length = GetLongPathName(full, buffer, (uint)buffer.Capacity);
        if (length >= buffer.Capacity)
        {
            buffer = new StringBuilder(checked((int)length));
            length = GetLongPathName(full, buffer, (uint)buffer.Capacity);
        }
        // Existing paths may use an 8.3 alias (for example RUNNER~1); a new install path may not exist yet.
        return (length > 0 && length < buffer.Capacity ? buffer.ToString() : full).TrimEnd('\\');
    }

    private static bool SamePath(string first, string second)
    {
        return String.Equals(CanonicalPath(first), CanonicalPath(second), StringComparison.OrdinalIgnoreCase);
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
        catch (Exception error)
        {
            // COM can map this HRESULT to FileNotFoundException instead of COMException.
            if (error.HResult == unchecked((int)0x80070002)) return null;
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
        return task != null && ((int)task.State == 2 || (int)task.State == 4 || (int)task.GetInstances(0).Count > 0);
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

    private static bool OwnedDesktopAdapter(string value)
    {
        if (SamePath(value, Path.Combine(AppDirectory, "Rele.Codex.exe"))) return true;
        string directory = Path.GetDirectoryName(Path.GetFullPath(value));
        string cache = Path.Combine(Config.DataDirectory, "codex-adapters");
        if (!String.Equals(Path.GetFileName(value), "Rele.Codex.exe", StringComparison.OrdinalIgnoreCase) ||
            !Regex.IsMatch(Path.GetFileName(directory), "^[a-f0-9]{64}$") || !SamePath(Path.GetDirectoryName(directory), cache)) return false;
        try
        {
            var marker = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(directory, "rele-install.json")));
            return Convert.ToInt32(marker["DesktopAdapterVersion"]) == 1 && (string)marker["OwnerSid"] == Config.OwnerSid && SamePath((string)marker["DataDirectory"], Config.DataDirectory);
        }
        catch { return false; }
    }

    private sealed class CodexWebSocketOwner
    {
        public int Version { get; set; }
        public string OwnerSid { get; set; }
        public string Executable { get; set; }
        public string ExecutableSha256 { get; set; }
        public string HostSha256 { get; set; }
        public string CodexHome { get; set; }
        public string Endpoint { get; set; }
        public string TaskName { get; set; }
    }

    private sealed class CodexWebSocketPointer
    {
        public int Version { get; set; }
        public string OwnerSid { get; set; }
        public string DataDirectory { get; set; }
        public string CodexHome { get; set; }
        public string Endpoint { get; set; }
        public string OwnerDirectory { get; set; }
        public string TaskName { get; set; }
    }

    private static string FileHash(string file)
    {
        using (var hash = SHA256.Create()) using (var input = File.OpenRead(file))
            return BitConverter.ToString(hash.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
    }

    private static string TextHash(string text)
    {
        using (var hash = SHA256.Create())
            return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-", "").ToLowerInvariant();
    }

    private static void AtomicJson(string file, string contents)
    {
        string temporary = file + "." + Guid.NewGuid().ToString("N") + ".new";
        try
        {
            File.WriteAllText(temporary, contents, new UTF8Encoding(false));
            if (File.Exists(file)) File.Replace(temporary, file, null); else File.Move(temporary, file);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private static Settings ReadInstallationSettings()
    {
        using (var input = new FileStream(Path.Combine(AppDirectory, "rele-install.json"), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        using (var reader = new StreamReader(input, Encoding.UTF8, true))
            return Json.Deserialize<Settings>(reader.ReadToEnd());
    }

    private static void ValidateInstallationOwner(Settings current)
    {
        if (current == null || (!String.IsNullOrEmpty(current.OwnerSid) && current.OwnerSid != WindowsIdentity.GetCurrent().User.Value) ||
            !SamePath(current.DataDirectory, Config.DataDirectory) || current.TaskName != Config.TaskName)
            throw new InvalidOperationException("Владелец или каталог установки Rele изменён; настройки сохранены.");
    }

    private static void ReloadOwnedInstallation(Dictionary<string, string> options, bool allowMissing = false)
    {
        if (!File.Exists(Path.Combine(AppDirectory, "rele-install.json")))
        {
            if (allowMissing) return;
            throw new InvalidOperationException("Установка Rele больше не существует; настройки не изменены.");
        }
        Settings current = ReadInstallationSettings();
        ValidateInstallationOwner(current);
        Config = current;
        Config.OwnerSid = WindowsIdentity.GetCurrent().User.Value;
        Config.CodexHome = Value(options, "--codex-home", Config.CodexHome);
        Config.Port = Int32.Parse(Value(options, "--port", Config.Port.ToString()));
        if (Config.Port < 0 || Config.Port > 65535) throw new InvalidOperationException("Недопустимый локальный порт Rele.");
    }

    private static FileStream CodexOperationLock(string name)
    {
        string directory = Path.Combine(Config.DataDirectory, "codex-websocket-owners");
        PrivateDirectory(directory);
        string file = Path.Combine(directory, name);
        if (File.Exists(file) && (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidOperationException("Файл блокировки Rele перенаправлен; настройки сохранены.");
        int timeoutMs = name == "integration.lock" ? 80000 : 15000;
        var wait = Stopwatch.StartNew();
        for (;;)
        {
            try { return new FileStream(file, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException error)
            {
                if ((error.HResult & 0xffff) != 32 || wait.ElapsedMilliseconds >= timeoutMs) throw;
                Thread.Sleep(50);
            }
        }
    }

    private static void SaveDesktopSettings()
    {
        // Preflight's child takes start.lock only; never wait for it while holding this short lock.
        using (var operation = CodexOperationLock("start.lock"))
        {
            string file = Path.Combine(AppDirectory, "rele-install.json");
            if (File.Exists(file))
            {
                Settings current = ReadInstallationSettings();
                ValidateInstallationOwner(current);
                Config.CodexWebSocketEndpoint = current.CodexWebSocketEndpoint;
                Config.CodexWebSocketOwnerDirectory = current.CodexWebSocketOwnerDirectory;
                Config.CodexWebSocketTaskName = current.CodexWebSocketTaskName;
            }
            AtomicJson(file, Json.Serialize(Config));
        }
    }

    private static void RestoreCodexWebSocketPointer(string cache, string codexHome)
    {
        if (!String.IsNullOrEmpty(Config.CodexWebSocketOwnerDirectory)) return;
        string file = Path.Combine(cache, "current.json");
        if (!File.Exists(file)) return;
        if (new FileInfo(file).Length > 65536) throw new InvalidOperationException("Сохранённое состояние владельца Codex повреждено.");
        CodexWebSocketPointer pointer = Json.Deserialize<CodexWebSocketPointer>(File.ReadAllText(file));
        if (pointer == null || pointer.Version != 1 || pointer.OwnerSid != Config.OwnerSid ||
            !SamePath(pointer.DataDirectory, Config.DataDirectory) || !SamePath(pointer.CodexHome, codexHome) ||
            pointer.TaskName != Config.TaskName + "-Codex" ||
            (!String.IsNullOrEmpty(Config.CodexWebSocketEndpoint) && Config.CodexWebSocketEndpoint != pointer.Endpoint))
            throw new InvalidOperationException("Сохранённый владелец Codex относится к другой установке или профилю.");
        WebSocketPort(pointer.Endpoint);
        Config.CodexWebSocketOwnerDirectory = pointer.OwnerDirectory;
        Config.CodexWebSocketEndpoint = pointer.Endpoint;
        Config.CodexWebSocketTaskName = pointer.TaskName;
        CodexWebSocketOwner owner = ReadCodexWebSocketOwner();
        if (owner == null || !SamePath(owner.CodexHome, pointer.CodexHome)) throw new InvalidOperationException("Профиль сохранённого владельца Codex изменён.");
    }

    private static void SaveCodexWebSocketPointer(string cache, CodexWebSocketOwner owner, string directory)
    {
        string file = Path.Combine(cache, "current.json");
        if (File.Exists(file))
        {
            if (new FileInfo(file).Length > 65536) throw new InvalidOperationException("Состояние владельца Codex повреждено; оно не перезаписано.");
            CodexWebSocketPointer previous = Json.Deserialize<CodexWebSocketPointer>(File.ReadAllText(file));
            if (previous == null || previous.Version != 1 || previous.OwnerSid != Config.OwnerSid ||
                !SamePath(previous.DataDirectory, Config.DataDirectory) || !SamePath(previous.CodexHome, owner.CodexHome) ||
                previous.TaskName != owner.TaskName || previous.Endpoint != owner.Endpoint)
                throw new InvalidOperationException("Сохранённое состояние Codex принадлежит другой установке или профилю; оно не перезаписано.");
        }
        AtomicJson(file, Json.Serialize(new CodexWebSocketPointer {
            Version = 1, OwnerSid = Config.OwnerSid, DataDirectory = Config.DataDirectory, CodexHome = owner.CodexHome,
            Endpoint = owner.Endpoint, OwnerDirectory = directory, TaskName = owner.TaskName
        }));
    }

    private static void PrivateDirectory(string directory, bool create = true)
    {
        SecurityIdentifier sid = WindowsIdentity.GetCurrent().User;
        if (!Directory.Exists(directory))
        {
            if (!create) throw new InvalidOperationException("Сохранённый каталог владельца Codex не найден.");
            var permissions = new System.Security.AccessControl.DirectorySecurity();
            permissions.SetOwner(sid);
            permissions.SetAccessRuleProtection(true, false);
            permissions.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(sid,
                System.Security.AccessControl.FileSystemRights.FullControl,
                System.Security.AccessControl.InheritanceFlags.ContainerInherit | System.Security.AccessControl.InheritanceFlags.ObjectInherit,
                System.Security.AccessControl.PropagationFlags.None, System.Security.AccessControl.AccessControlType.Allow));
            Directory.CreateDirectory(directory, permissions);
        }
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidOperationException("Каталог владельца Codex перенаправлен; запуск отменён.");
        var actual = Directory.GetAccessControl(directory);
        if (!actual.GetOwner(typeof(SecurityIdentifier)).Equals(sid) || !actual.AreAccessRulesProtected)
            throw new InvalidOperationException("Каталог владельца Codex принадлежит другой учётной записи или не защищён.");
        foreach (System.Security.AccessControl.FileSystemAccessRule rule in actual.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            if (rule.AccessControlType == System.Security.AccessControl.AccessControlType.Allow && !rule.IdentityReference.Equals(sid))
                throw new InvalidOperationException("Каталог владельца Codex доступен другой учётной записи.");
    }

    private static int WebSocketPort(string endpoint)
    {
        Uri address;
        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out address) || address.Scheme != "ws" || address.Host != "127.0.0.1" ||
            address.Port <= 0 || address.Port > 65535 || address.AbsolutePath != "/" || !String.IsNullOrEmpty(address.Query) ||
            !String.IsNullOrEmpty(address.Fragment) || !String.IsNullOrEmpty(address.UserInfo))
            throw new InvalidOperationException("Общий Codex должен слушать только ws://127.0.0.1:PORT.");
        return address.Port;
    }

    private static CodexWebSocketOwner ReadCodexWebSocketOwner(string directory = null)
    {
        directory = directory ?? Config.CodexWebSocketOwnerDirectory;
        if (String.IsNullOrEmpty(directory)) return null;
        string cache = Path.Combine(Config.DataDirectory, "codex-websocket-owners");
        if (!SamePath(Path.GetDirectoryName(directory), cache) || !Regex.IsMatch(Path.GetFileName(directory), "^[a-f0-9]{64}$"))
            throw new InvalidOperationException("Не удалось подтвердить каталог владельца Codex.");
        PrivateDirectory(cache, false); PrivateDirectory(directory, false);
        string markerPath = Path.Combine(directory, "owner.json");
        if (new FileInfo(markerPath).Length > 65536) throw new InvalidOperationException("Маркер владельца Codex повреждён.");
        string marker = File.ReadAllText(markerPath);
        CodexWebSocketOwner owner = Json.Deserialize<CodexWebSocketOwner>(marker);
        if (owner == null || owner.Version != 1 || TextHash(marker) != Path.GetFileName(directory) ||
            owner.OwnerSid != Config.OwnerSid || owner.TaskName != Config.TaskName + "-Codex" ||
            (!String.IsNullOrEmpty(Config.CodexWebSocketTaskName) && owner.TaskName != Config.CodexWebSocketTaskName) ||
            owner.Endpoint != Config.CodexWebSocketEndpoint || !Path.IsPathRooted(owner.Executable) ||
            !Path.IsPathRooted(owner.CodexHome) || !Regex.IsMatch(owner.ExecutableSha256 ?? "", "^[a-f0-9]{64}$") ||
            !Regex.IsMatch(owner.HostSha256 ?? "", "^[a-f0-9]{64}$") ||
            FileHash(Path.Combine(directory, "Rele.Process.exe")) != owner.HostSha256)
            throw new InvalidOperationException("Сохранённый владелец Codex изменён; чужие процессы и задачи не затронуты.");
        WebSocketPort(owner.Endpoint);
        return owner;
    }

    private static bool SameCodexWebSocketScope(CodexWebSocketOwner first, CodexWebSocketOwner second)
    {
        return first.OwnerSid == second.OwnerSid && first.TaskName == second.TaskName && first.Endpoint == second.Endpoint &&
            SamePath(first.Executable, second.Executable) && first.ExecutableSha256 == second.ExecutableSha256 && SamePath(first.CodexHome, second.CodexHome);
    }

    private static dynamic OwnedCodexWebSocketTask(dynamic folder, CodexWebSocketOwner owner, string directory)
    {
        string scheduledDirectory;
        return OwnedCodexWebSocketTask(folder, owner, directory, out scheduledDirectory);
    }

    private static dynamic OwnedCodexWebSocketTask(dynamic folder, CodexWebSocketOwner owner, string directory, out string scheduledDirectory)
    {
        scheduledDirectory = directory;
        dynamic task;
        try { task = folder.GetTask(owner.TaskName); }
        catch (Exception error) { if (error.HResult == unchecked((int)0x80070002)) return null; throw; }
        dynamic definition = task.Definition;
        if (definition.Actions.Count != 1 || definition.Actions[1].Type != 0 ||
            !IsCurrentUser((string)definition.Principal.UserId) || (int)definition.Principal.LogonType != 3 || (int)definition.Principal.RunLevel != 0)
            throw new InvalidOperationException("Задача общего Codex принадлежит другой установке; она не изменена.");
        scheduledDirectory = Path.GetDirectoryName((string)definition.Actions[1].Path);
        CodexWebSocketOwner scheduled = ReadCodexWebSocketOwner(scheduledDirectory);
        if (scheduled == null || !SameCodexWebSocketScope(owner, scheduled) ||
            (!SamePath(directory, scheduledDirectory) && (int)definition.Settings.MultipleInstances != 2) ||
            !SamePath((string)definition.Actions[1].Path, Path.Combine(scheduledDirectory, "Rele.Process.exe")) ||
            (string)definition.Actions[1].Arguments != "--codex-websocket-owner " + QuoteArgument(Path.Combine(scheduledDirectory, "owner.json")) ||
            !SamePath((string)definition.Actions[1].WorkingDirectory, scheduledDirectory))
            throw new InvalidOperationException("Задача общего Codex принадлежит другой установке; она не изменена.");
        return task;
    }

    private static string StageCodexWebSocketOwner(CodexWebSocketOwner owner, string source)
    {
        string cache = Path.Combine(Config.DataDirectory, "codex-websocket-owners");
        string marker = Json.Serialize(owner), directory = Path.Combine(cache, TextHash(marker));
        if (!Directory.Exists(directory))
        {
            string temporary = Path.Combine(cache, ".prepare-" + Guid.NewGuid().ToString("N"));
            PrivateDirectory(temporary);
            try
            {
                File.Copy(source, Path.Combine(temporary, "Rele.Process.exe"), false);
                File.WriteAllText(Path.Combine(temporary, "owner.json"), marker, new UTF8Encoding(false));
                Directory.Move(temporary, directory);
            }
            finally { if (Directory.Exists(temporary)) Directory.Delete(temporary, true); }
        }
        ReadCodexWebSocketOwner(directory);
        return directory;
    }

    private static void SaveCodexWebSocketOwner(CodexWebSocketOwner owner, string directory)
    {
        Config.CodexWebSocketOwnerDirectory = directory; Config.CodexWebSocketTaskName = owner.TaskName;
        SaveCodexWebSocketPointer(Path.Combine(Config.DataDirectory, "codex-websocket-owners"), owner, directory);
        AtomicJson(Path.Combine(AppDirectory, "rele-install.json"), Json.Serialize(Config));
    }

    private static string QuoteArgument(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            result.Append('\\', character == '"' ? slashes * 2 + 1 : slashes).Append(character); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    private static void RegisterCodexWebSocketTask(CodexWebSocketOwner owner, string directory)
    {
        dynamic folder = TaskFolder();
        dynamic previous = OwnedCodexWebSocketTask(folder, owner, directory);
        bool enabled = previous == null || (bool)previous.Enabled;
        if (previous != null && HasCodexRecoveryTrigger(previous))
        {
            dynamic definition = previous.Definition;
            definition.Actions[1].Path = Path.Combine(directory, "Rele.Process.exe");
            definition.Actions[1].Arguments = "--codex-websocket-owner " + QuoteArgument(Path.Combine(directory, "owner.json"));
            definition.Actions[1].WorkingDirectory = directory;
            folder.RegisterTaskDefinition(owner.TaskName, definition, 6, Config.OwnerSid, null, 3, null);
            return;
        }
        string user = SecurityElement.Escape(Config.OwnerSid);
        string xml = "<?xml version=\"1.0\" encoding=\"UTF-16\"?>" +
            "<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">" +
            "<RegistrationInfo><Description>Rele: общий локальный Codex текущего пользователя; независим от gateway.</Description></RegistrationInfo>" +
            "<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>" + user + "</UserId></LogonTrigger>" +
            "<TimeTrigger><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>" +
            "<StartBoundary>" + DateTime.UtcNow.AddMinutes(1).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", System.Globalization.CultureInfo.InvariantCulture) +
            "</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>" +
            "<Principals><Principal id=\"User\"><UserId>" + user + "</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>" +
            "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>" +
            "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><Enabled>" + (enabled ? "true" : "false") + "</Enabled>" +
            "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>" +
            "<Actions Context=\"User\"><Exec><Command>" + SecurityElement.Escape(Path.Combine(directory, "Rele.Process.exe")) +
            "</Command><Arguments>" + SecurityElement.Escape("--codex-websocket-owner " + QuoteArgument(Path.Combine(directory, "owner.json"))) +
            "</Arguments><WorkingDirectory>" + SecurityElement.Escape(directory) + "</WorkingDirectory></Exec></Actions></Task>";
        folder.RegisterTask(owner.TaskName, xml, 6, Config.OwnerSid, null, 3, null);
    }

    private static bool HasCodexRecoveryTrigger(dynamic task)
    {
        dynamic definition = task.Definition;
        if ((int)definition.Settings.MultipleInstances != 2) return false; // IgnoreNew preserves the live owner.
        foreach (dynamic trigger in definition.Triggers)
            if ((int)trigger.Type == 1 && (bool)trigger.Enabled &&
                !String.IsNullOrEmpty((string)trigger.Repetition.Interval) &&
                System.Xml.XmlConvert.ToTimeSpan((string)trigger.Repetition.Interval) == TimeSpan.FromMinutes(1) &&
                String.IsNullOrEmpty((string)trigger.Repetition.Duration) && !(bool)trigger.Repetition.StopAtDurationEnd)
                return true;
        return false;
    }

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);

    private static bool IsOwnProcess(Process process, string executable, string startedAt)
    {
        DateTime expected;
        IntPtr token = IntPtr.Zero;
        if (!DateTime.TryParse(startedAt, System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.RoundtripKind, out expected))
            throw new InvalidOperationException("Не удалось прочитать время запуска общего Codex.");
        if (process.StartTime.ToUniversalTime().Ticks != expected.ToUniversalTime().Ticks) return false;
        if (!SamePath(process.MainModule.FileName, executable) || !OpenProcessToken(process.Handle, 8, out token))
            throw new InvalidOperationException("Не удалось подтвердить PID и время запуска общего Codex.");
        try { using (var identity = new WindowsIdentity(token)) if (identity.User.Value != Config.OwnerSid) throw new InvalidOperationException("Процесс общего Codex принадлежит другой учётной записи."); }
        finally { CloseHandle(token); }
        return true;
    }

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool sorted, int family, int tableClass, uint reserved);

    private static bool OwnCodexListener(string endpoint, int nativePid)
    {
        int port = WebSocketPort(endpoint), size = 0;
        uint result = GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 3, 0); // AF_INET, OWNER_PID_LISTENER
        if (result != 122 || size < 4 || size > 2 * 1024 * 1024) throw new InvalidOperationException("Не удалось проверить владельца локального порта Codex.");
        for (int attempt = 0; attempt < 3; attempt++)
        {
            int capacity = size;
            IntPtr table = Marshal.AllocHGlobal(capacity);
            try
            {
                result = GetExtendedTcpTable(table, ref size, false, 2, 3, 0);
                if (result == 122)
                {
                    if (size < 4 || size > 2 * 1024 * 1024) break;
                    continue;
                }
                if (result != 0 || size < 4 || size > capacity) break;
                int count = Marshal.ReadInt32(table);
                if (count < 0 || count > (size - 4) / 24) break;
                bool found = false;
                for (int index = 0; index < count; index++)
                {
                    IntPtr row = IntPtr.Add(table, 4 + index * 24);
                    int address = Marshal.ReadInt32(row, 4), networkPort = Marshal.ReadInt32(row, 8);
                    int localPort = ((networkPort & 255) << 8) | ((networkPort >> 8) & 255);
                    if (localPort != port || (address != 0x0100007f && address != 0)) continue;
                    if (address != 0x0100007f || Marshal.ReadInt32(row, 20) != nativePid)
                        throw new InvalidOperationException("Порт общего Codex принадлежит другому процессу; подключение отменено.");
                    found = true;
                }
                return found;
            }
            finally { Marshal.FreeHGlobal(table); }
        }
        throw new InvalidOperationException("Не удалось подтвердить владельца локального порта Codex.");
    }

    private static Dictionary<string, object> CodexWebSocketReceipt(CodexWebSocketOwner owner, string directory, string status)
    {
        string scheduledDirectory;
        OwnedCodexWebSocketTask(TaskFolder(), owner, directory, out scheduledDirectory);
        var active = ReadCodexWebSocketReceipt(owner, directory, status);
        if (active != null || SamePath(directory, scheduledDirectory)) return active;
        CodexWebSocketOwner scheduled = ReadCodexWebSocketOwner(scheduledDirectory);
        active = ReadCodexWebSocketReceipt(scheduled, scheduledDirectory, status);
        return active;
    }

    private static Dictionary<string, object> ReadCodexWebSocketReceipt(CodexWebSocketOwner owner, string directory, string status)
    {
        string file = Path.Combine(directory, "receipt.json");
        if (!File.Exists(file)) return null;
        if (new FileInfo(file).Length > 65536) throw new InvalidOperationException("Результат запуска Codex повреждён.");
        Dictionary<string, object> receipt;
        try { receipt = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(file)); }
        catch (IOException) { return null; }
        if ((string)receipt["status"] != "running") return null;
        if ((string)receipt["ownerSid"] != owner.OwnerSid || (string)receipt["endpoint"] != owner.Endpoint ||
            !SamePath((string)receipt["codexHome"], owner.CodexHome) || !SamePath((string)receipt["executable"], owner.Executable) ||
            (string)receipt["executableSha256"] != owner.ExecutableSha256)
            throw new InvalidOperationException("Результат запуска общего Codex не соответствует установке.");
        try
        {
            using (Process host = Process.GetProcessById(Convert.ToInt32(receipt["hostPid"])))
            using (Process native = Process.GetProcessById(Convert.ToInt32(receipt["nativePid"])))
            {
                if (!IsOwnProcess(host, Path.Combine(directory, "Rele.Process.exe"), (string)receipt["hostStartedAt"]) ||
                    !IsOwnProcess(native, owner.Executable, (string)receipt["nativeStartedAt"])) return null;
                if (!OwnCodexListener(owner.Endpoint, native.Id)) return null;
                if (FileHash(owner.Executable) != owner.ExecutableSha256) throw new InvalidOperationException("Работающий backend Codex изменён.");
                return new Dictionary<string, object> {
                    { "status", status }, { "endpoint", owner.Endpoint }, { "codexHome", owner.CodexHome }, { "executable", owner.Executable },
                    { "executableSha256", owner.ExecutableSha256 }, { "ownerSid", owner.OwnerSid }, { "ownerDirectory", directory },
                    { "taskName", owner.TaskName }, { "processId", native.Id }, { "processStartTime", native.StartTime.ToUniversalTime().ToString("o") }
                };
            }
        }
        catch (ArgumentException) { return null; } // An obsolete PID is pending, never proof that a foreign process is ours.
    }

    private static Dictionary<string, object> CodexWebSocketStatus(string codexHome)
    {
        if (!Path.IsPathRooted(codexHome)) throw new InvalidOperationException("Исходный профиль Codex должен быть абсолютным путём.");
        codexHome = CanonicalPath(codexHome);
        if (!Regex.IsMatch(codexHome, @"^[A-Za-z]:\\") || codexHome.Length <= 3)
            throw new InvalidOperationException("Исходный профиль Codex должен находиться на локальном диске.");
        string cache = Path.Combine(Config.DataDirectory, "codex-websocket-owners");
        if (!Directory.Exists(cache))
        {
            if (!String.IsNullOrEmpty(Config.CodexWebSocketOwnerDirectory)) throw new InvalidOperationException("Сохранённое состояние владельца Codex недоступно.");
            return new Dictionary<string, object> { { "status", "notRunning" } };
        }
        PrivateDirectory(cache, false);
        RestoreCodexWebSocketPointer(cache, codexHome);
        CodexWebSocketOwner owner = ReadCodexWebSocketOwner();
        if (owner == null) return new Dictionary<string, object> { { "status", "notRunning" } };
        if (!SamePath(owner.CodexHome, codexHome)) throw new InvalidOperationException("Общий Codex использует другой исходный профиль.");
        return CodexWebSocketReceipt(owner, Config.CodexWebSocketOwnerDirectory, "alreadyRunning") ??
            new Dictionary<string, object> { { "status", "notRunning" } };
    }

    private static Dictionary<string, object> StartCodexWebSocket(string executable, string codexHome, bool preserveActive)
    {
        if (!Path.IsPathRooted(executable) || !Path.IsPathRooted(codexHome)) throw new InvalidOperationException("Backend и профиль Codex должны быть абсолютными путями.");
        executable = CanonicalPath(executable); codexHome = CanonicalPath(codexHome);
        if (!File.Exists(executable)) throw new InvalidOperationException("Не найден штатный backend Codex.");
        if (!Regex.IsMatch(codexHome, @"^[A-Za-z]:\\") || codexHome.Length <= 3)
            throw new InvalidOperationException("Исходный профиль Codex должен находиться на локальном диске.");
        string ancestor = Path.GetPathRoot(codexHome);
        foreach (string part in codexHome.Substring(ancestor.Length).Split('\\'))
        {
            ancestor = Path.Combine(ancestor, part);
            if ((Directory.Exists(ancestor) || File.Exists(ancestor)) && (File.GetAttributes(ancestor) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("Путь исходного профиля Codex перенаправлен; автоматическое создание отменено.");
        }
        // A Desktop-only fresh install may not have opened its original profile yet.
        Directory.CreateDirectory(codexHome);
        string cache = Path.Combine(Config.DataDirectory, "codex-websocket-owners"); PrivateDirectory(cache);
        using (var operation = CodexOperationLock("start.lock"))
        {
            // desktop-check can run in another process; merge its endpoint before any settings write.
            Config = ReadInstallationSettings();
            if (Config.OwnerSid != WindowsIdentity.GetCurrent().User.Value) throw new InvalidOperationException("Установка принадлежит другой учётной записи.");
            RestoreCodexWebSocketPointer(cache, codexHome);
            CodexWebSocketOwner previous = ReadCodexWebSocketOwner();
            if (previous != null)
            {
                dynamic previousTask = OwnedCodexWebSocketTask(TaskFolder(), previous, Config.CodexWebSocketOwnerDirectory);
                var activeWait = Stopwatch.StartNew();
                do
                {
                    var active = CodexWebSocketReceipt(previous, Config.CodexWebSocketOwnerDirectory, "alreadyRunning");
                    if (active != null)
                    {
                        if ((!preserveActive && !SamePath(previous.Executable, executable)) || !SamePath(previous.CodexHome, codexHome))
                            throw new InvalidOperationException("Общий Codex уже работает с другим backend или профилем; работающие задачи не остановлены.");
                        string activeDirectory = (string)active["ownerDirectory"];
                        previous = ReadCodexWebSocketOwner(activeDirectory);
                        SaveCodexWebSocketOwner(previous, activeDirectory);
                        string hostSource = Path.Combine(AppDirectory, "dist", "native", "Rele.Process.exe");
                        string sourceHash = FileHash(hostSource);
                        if (sourceHash != previous.HostSha256 && previousTask != null && (int)previousTask.State == 4 &&
                            (int)previousTask.Definition.Settings.MultipleInstances == 2)
                        {
                            // Replace only the future action of this same running Task; IgnoreNew preserves its live owner.
                            var successor = new CodexWebSocketOwner { Version = 1, OwnerSid = previous.OwnerSid, Executable = previous.Executable,
                                ExecutableSha256 = previous.ExecutableSha256, HostSha256 = sourceHash, CodexHome = previous.CodexHome,
                                Endpoint = previous.Endpoint, TaskName = previous.TaskName };
                            string successorDirectory = StageCodexWebSocketOwner(successor, hostSource), scheduledDirectory;
                            OwnedCodexWebSocketTask(TaskFolder(), previous, Config.CodexWebSocketOwnerDirectory, out scheduledDirectory);
                            if (!SamePath(successorDirectory, scheduledDirectory) || !HasCodexRecoveryTrigger(previousTask))
                                RegisterCodexWebSocketTask(successor, successorDirectory);
                        }
                        // A missing/non-running Task cannot exclude a second owner in a different cache; retain the old owner.lock until cold start.
                        else if (previousTask == null || !HasCodexRecoveryTrigger(previousTask))
                            RegisterCodexWebSocketTask(previous, Config.CodexWebSocketOwnerDirectory);
                        return active; // Never Run or Stop a Task while its verified native server is active.
                    }
                    if (!TaskActive(previousTask)) break;
                    Thread.Sleep(100);
                }
                while (activeWait.ElapsedMilliseconds < 15000);
                if (TaskActive(previousTask)) throw new InvalidOperationException("Работающая задача Codex не подтвердила свой PID и порт.");
            }
            int port;
            if (String.IsNullOrEmpty(Config.CodexWebSocketEndpoint))
            {
                var listener = new TcpListener(IPAddress.Loopback, 0); listener.ExclusiveAddressUse = true;
                listener.Start(); port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop();
                Config.CodexWebSocketEndpoint = "ws://127.0.0.1:" + port;
            }
            else port = WebSocketPort(Config.CodexWebSocketEndpoint);
            var available = new TcpListener(IPAddress.Loopback, port); available.ExclusiveAddressUse = true;
            try { available.Start(); } catch (SocketException) { throw new InvalidOperationException("Адрес общего Codex занят неподтверждённым процессом; другой порт не выбран."); }
            finally { available.Stop(); }
            string source = Path.Combine(AppDirectory, "dist", "native", "Rele.Process.exe");
            var owner = new CodexWebSocketOwner { Version = 1, OwnerSid = Config.OwnerSid, Executable = executable,
                ExecutableSha256 = FileHash(executable), HostSha256 = FileHash(source), CodexHome = codexHome,
                Endpoint = Config.CodexWebSocketEndpoint, TaskName = Config.TaskName + "-Codex" };
            string directory = StageCodexWebSocketOwner(owner, source);
            if (previous != null && !SamePath(directory, Config.CodexWebSocketOwnerDirectory))
            {
                dynamic old = OwnedCodexWebSocketTask(TaskFolder(), previous, Config.CodexWebSocketOwnerDirectory);
                if (TaskActive(old)) throw new InvalidOperationException("Прежний владелец Codex ещё работает.");
                if (old != null) TaskFolder().DeleteTask(previous.TaskName, 0);
            }
            SaveCodexWebSocketOwner(owner, directory);
            RegisterCodexWebSocketTask(owner, directory);
            dynamic task = OwnedCodexWebSocketTask(TaskFolder(), owner, directory);
            string receiptFile = Path.Combine(directory, "receipt.json");
            if (File.Exists(receiptFile)) File.Delete(receiptFile);
            task.Run(null);
            var wait = Stopwatch.StartNew();
            while (wait.ElapsedMilliseconds < 15000)
            {
                var receipt = CodexWebSocketReceipt(owner, directory, "started");
                if (receipt != null) return receipt;
                if (!TaskActive(task) && (int)task.LastTaskResult != 0x41303 && (int)task.LastTaskResult != 0x41301)
                    throw new InvalidOperationException("Штатный backend Codex не запустился (" + (int)task.LastTaskResult + ").");
                Thread.Sleep(100);
            }
            throw new InvalidOperationException("Общий Codex не подтвердил запуск за 15 секунд.");
        }
    }

    private static void RemoveCodexWebSocketStartup()
    {
        if (String.IsNullOrEmpty(Config.CodexWebSocketOwnerDirectory)) return;
        using (var operation = CodexOperationLock("start.lock"))
        {
            Settings current = ReadInstallationSettings(); ValidateInstallationOwner(current); Config = current;
            CodexWebSocketOwner owner = ReadCodexWebSocketOwner();
            if (owner == null) return;
            var active = CodexWebSocketReceipt(owner, Config.CodexWebSocketOwnerDirectory, "alreadyRunning");
            if (active != null && !SamePath((string)active["ownerDirectory"], Config.CodexWebSocketOwnerDirectory))
            {
                owner = ReadCodexWebSocketOwner((string)active["ownerDirectory"]);
                SaveCodexWebSocketOwner(owner, (string)active["ownerDirectory"]); // Preserve the live successor route before deleting its Task.
            }
            string scheduledDirectory;
            dynamic folder = TaskFolder(), task = OwnedCodexWebSocketTask(folder, owner, Config.CodexWebSocketOwnerDirectory, out scheduledDirectory);
            if (active == null && !SamePath(scheduledDirectory, Config.CodexWebSocketOwnerDirectory) && TaskActive(task))
                throw new InvalidOperationException("Новый владелец Codex ещё не подтвердил запуск; фоновая задача сохранена. Повторите удаление после завершения запуска.");
            if (task != null) { task.Enabled = false; folder.DeleteTask(owner.TaskName, 0); }
            // Active native tasks survive uninstall; their immutable host/marker remain in the data directory.
            Log("Codex startup removed; the current native server and immutable owner files are preserved: " + Config.CodexWebSocketOwnerDirectory);
        }
    }

    private static string UserEnvironment(string name)
    {
        return Environment.GetEnvironmentVariable(name, EnvironmentVariableTarget.User);
    }

    private static void ValidateDesktopIntegration()
    {
        string inheritedCli = Environment.GetEnvironmentVariable("CODEX_CLI_PATH");
        if (!String.IsNullOrEmpty(inheritedCli) && OwnedDesktopAdapter(inheritedCli) && String.IsNullOrEmpty(UserEnvironment("CODEX_CLI_PATH")))
        {
            // A still-running gateway can retain the old environment after compare-and-restore.
            Environment.SetEnvironmentVariable("CODEX_CLI_PATH", null);
            if (Environment.GetEnvironmentVariable("CODEX_APP_SERVER_FORCE_CLI") == "1" && String.IsNullOrEmpty(UserEnvironment("CODEX_APP_SERVER_FORCE_CLI")))
                Environment.SetEnvironmentVariable("CODEX_APP_SERVER_FORCE_CLI", null);
        }
        foreach (EnvironmentVariableTarget scope in new[] { EnvironmentVariableTarget.Process, EnvironmentVariableTarget.User, EnvironmentVariableTarget.Machine })
        {
            string endpoint = Environment.GetEnvironmentVariable("CODEX_APP_SERVER_WS_URL", scope);
            if (!String.IsNullOrEmpty(endpoint) && (scope == EnvironmentVariableTarget.Machine || endpoint != Config.InstalledCodexWebSocketUrl ||
                (scope == EnvironmentVariableTarget.User && !Config.DesktopIntegrationOwned)))
                throw new InvalidOperationException("Подключение Desktop не изменено: CODEX_APP_SERVER_WS_URL принадлежит другой настройке.");
            string cli = Environment.GetEnvironmentVariable("CODEX_CLI_PATH", scope);
            if (!String.IsNullOrEmpty(cli))
                throw new InvalidOperationException("Подключение Desktop не изменено: CODEX_CLI_PATH уже настроен. Штатный backend Desktop не подменяется.");
            string force = Environment.GetEnvironmentVariable("CODEX_APP_SERVER_FORCE_CLI", scope);
            if (!String.IsNullOrEmpty(force))
                throw new InvalidOperationException("Подключение Desktop не изменено: CODEX_APP_SERVER_FORCE_CLI уже настроен иначе. Проверьте его вручную.");
        }
    }

    private static void RemoveLegacyDesktopIntegration()
    {
        if (!Config.DesktopIntegrationOwned || !String.IsNullOrEmpty(Config.InstalledCodexWebSocketUrl)) return;
        string cli = UserEnvironment("CODEX_CLI_PATH");
        if (!String.IsNullOrEmpty(cli) && OwnedDesktopAdapter(cli))
        {
            SetUserEnvironment("CODEX_CLI_PATH", Config.PreviousCodexCliPath);
            if (UserEnvironment("CODEX_APP_SERVER_FORCE_CLI") == "1") SetUserEnvironment("CODEX_APP_SERVER_FORCE_CLI", Config.PreviousForceCli);
        }
        Config.DesktopIntegrationOwned = false;
        SaveDesktopSettings();
        BroadcastEnvironment();
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessMitigationPolicy(IntPtr process, int policy, out uint flags, UIntPtr length);

    private static dynamic OwnedDesktopCheckTask(dynamic folder, string name, string arguments)
    {
        dynamic task;
        try { task = folder.GetTask(name); }
        catch (Exception error)
        {
            if (error.HResult == unchecked((int)0x80070002)) return null;
            throw;
        }
        dynamic definition = task.Definition;
        if (definition.Actions.Count != 1 || definition.Actions[1].Type != 0 ||
            !SamePath((string)definition.Actions[1].Path, Path.Combine(AppDirectory, "Rele.exe")) ||
            (string)definition.Actions[1].Arguments != arguments ||
            !SamePath((string)definition.Actions[1].WorkingDirectory, AppDirectory) ||
            !IsCurrentUser((string)definition.Principal.UserId) ||
            (int)definition.Principal.LogonType != 3 || (int)definition.Principal.RunLevel != 0)
            throw new InvalidOperationException("Не удалось подтвердить владельца временной проверки Desktop. Чужая задача не изменена.");
        return task;
    }

    private static void CheckDesktopIntegration(bool prepareCodex)
    {
        uint flags;
        if (!GetProcessMitigationPolicy(new IntPtr(-1), 16, out flags, new UIntPtr(4)))
        {
            int error = Marshal.GetLastWin32Error();
            if (error != 87) throw new InvalidOperationException("Не удалось проверить защиту процесса Windows (" + error + ").");
            flags = 0; // Older Windows versions do not support this mitigation policy.
        }
        if ((flags & 1) == 0) { RunNode(prepareCodex ? "--rele-desktop-setup" : "--rele-desktop-check", false, true); return; }

        // Inno's inherited RedirectionGuard blocks Codex's per-user current junction.
        // Keep the installer protected; Task Scheduler starts only this Desktop check outside its process tree.
        string nonce = Guid.NewGuid().ToString("N");
        string name = "Rele-DesktopCheck-" + nonce;
        string directory = Path.Combine(Config.DataDirectory, "desktop-check-" + nonce);
        var permissions = new System.Security.AccessControl.DirectorySecurity();
        SecurityIdentifier sid = WindowsIdentity.GetCurrent().User;
        permissions.SetOwner(sid);
        permissions.SetAccessRuleProtection(true, false);
        permissions.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(sid,
            System.Security.AccessControl.FileSystemRights.FullControl,
            System.Security.AccessControl.InheritanceFlags.ContainerInherit | System.Security.AccessControl.InheritanceFlags.ObjectInherit,
            System.Security.AccessControl.PropagationFlags.None, System.Security.AccessControl.AccessControlType.Allow));
        if (Directory.Exists(directory) || File.Exists(directory)) throw new InvalidOperationException("Каталог проверки Desktop уже существует.");
        dynamic folder = TaskFolder();
        string receipt = Path.Combine(directory, "result.txt");
        string arguments = "desktop-check --quiet --error-file \"" + receipt + "\"";
        if (prepareCodex) arguments += " --prepare-codex";
        // Scheduler does not inherit the installer's environment: keep this check on its original profile.
        string home = Config.CodexHome;
        if (String.IsNullOrEmpty(home)) home = Environment.GetEnvironmentVariable("CODEX_HOME");
        if (String.IsNullOrEmpty(home)) home = Path.Combine(Environment.GetEnvironmentVariable("USERPROFILE") ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
        if (home.IndexOf('"') >= 0) throw new InvalidOperationException("Путь профиля Codex содержит недопустимую кавычку.");
        arguments += " --codex-home \"" + Regex.Replace(home, @"(\\+)$", "$1$1") + "\"";
        Directory.CreateDirectory(directory, permissions);
        Exception failure = null;
        try
        {
            string xml = "<?xml version=\"1.0\" encoding=\"UTF-16\"?>" +
                "<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">" +
                "<Principals><Principal id=\"User\"><UserId>" + sid.Value + "</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>" +
                "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>" +
                "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT90S</ExecutionTimeLimit></Settings>" +
                "<Actions Context=\"User\"><Exec><Command>" + SecurityElement.Escape(Path.Combine(AppDirectory, "Rele.exe")) +
                "</Command><Arguments>" + SecurityElement.Escape(arguments) + "</Arguments><WorkingDirectory>" + SecurityElement.Escape(AppDirectory) +
                "</WorkingDirectory></Exec></Actions></Task>";
            folder.RegisterTask(name, xml, 2, sid.Value, null, 3, null); // Create only; never replace an existing task.
            dynamic task = OwnedDesktopCheckTask(folder, name, arguments);
            task.Run(null);
            var wait = Stopwatch.StartNew();
            while (TaskActive(task) || (int)task.State == 4 || !File.Exists(receipt) ||
                (int)task.LastTaskResult == 0x41301 || (int)task.LastTaskResult == 0x41303)
            {
                if (wait.ElapsedMilliseconds >= 75000) throw new InvalidOperationException("Проверка Desktop не завершилась за 75 секунд.");
                Thread.Sleep(100);
            }
            if (new FileInfo(receipt).Length > 8192) throw new InvalidOperationException("Проверка Desktop вернула недопустимый результат.");
            string error = File.ReadAllText(receipt);
            if ((int)task.LastTaskResult != 0 || error.Length != 0)
                throw new InvalidOperationException(error.Length == 0 ? "Проверка Desktop завершилась с ошибкой." : error);
        }
        catch (Exception error) { failure = error; throw; }
        finally
        {
            try
            {
                dynamic task = OwnedDesktopCheckTask(folder, name, arguments);
                if (task != null && TaskActive(task))
                {
                    task.Stop(0);
                    var wait = Stopwatch.StartNew();
                    while (TaskActive(task) && wait.ElapsedMilliseconds < 5000) Thread.Sleep(100);
                }
                task = OwnedDesktopCheckTask(folder, name, arguments);
                if (task != null)
                {
                    if (TaskActive(task) || (int)task.State == 4) throw new InvalidOperationException("Временная проверка Desktop ещё работает; её задача и результат сохранены.");
                    folder.DeleteTask(name, 0);
                }
                Directory.Delete(directory, true);
            }
            catch (Exception cleanup)
            {
                if (failure == null) throw;
                Log("Desktop check cleanup failed: " + cleanup.Message);
            }
        }
    }

    private static void InstallDesktopIntegration(bool prepareCodex)
    {
        // Restore only RC19's own adapter before checking a direct native connection.
        RemoveLegacyDesktopIntegration();
        ValidateDesktopIntegration();
        try { CheckDesktopIntegration(prepareCodex); }
        catch (Exception error)
        {
            Config = ReadInstallationSettings();
            RemoveDesktopIntegration();
            Config.DesktopIntegrationWarning = error.Message;
            throw;
        }
        // The check starts an independent owner and persists its stable endpoint in this file.
        Config = ReadInstallationSettings();
        ValidateDesktopIntegration();
        WebSocketPort(Config.CodexWebSocketEndpoint);
        string previous = UserEnvironment("CODEX_APP_SERVER_WS_URL");
        if (!Config.DesktopIntegrationOwned) Config.PreviousCodexWebSocketUrl = previous;
        try
        {
            Config.InstalledCodexWebSocketUrl = Config.CodexWebSocketEndpoint;
            SetUserEnvironment("CODEX_APP_SERVER_WS_URL", Config.InstalledCodexWebSocketUrl);
            Config.DesktopIntegrationOwned = true;
            Config.DesktopIntegrationWarning = null;
        }
        catch
        {
            SetUserEnvironment("CODEX_APP_SERVER_WS_URL", previous);
            throw;
        }
        BroadcastEnvironment();
    }

    private static void RemoveDesktopIntegration()
    {
        RemoveLegacyDesktopIntegration();
        if (!Config.DesktopIntegrationOwned) return;
        if (!String.IsNullOrEmpty(Config.InstalledCodexWebSocketUrl) && UserEnvironment("CODEX_APP_SERVER_WS_URL") == Config.InstalledCodexWebSocketUrl)
            SetUserEnvironment("CODEX_APP_SERVER_WS_URL", Config.PreviousCodexWebSocketUrl);
        Config.DesktopIntegrationOwned = false;
        Config.DesktopIntegrationWarning = null;
        BroadcastEnvironment();
    }

    private static void SetUserEnvironment(string name, string value)
    {
        Environment.SetEnvironmentVariable(name, value, EnvironmentVariableTarget.User);
        Environment.SetEnvironmentVariable(name, value, EnvironmentVariableTarget.Process);
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr parameter, string value, uint flags, uint milliseconds, out UIntPtr result);

    private static void BroadcastEnvironment()
    {
        UIntPtr result;
        SendMessageTimeout(new IntPtr(0xffff), 0x001a, UIntPtr.Zero, "Environment", 2, 1000, out result);
    }

    private static int RunNode(string command, bool background, bool codex = false)
    {
        var start = new ProcessStartInfo(Path.Combine(AppDirectory, "runtime", "node.exe"), "\"" + Path.Combine(AppDirectory, "dist", "server", codex ? "codex-cli.js" : "main.js") + "\" " + command)
        {
            WorkingDirectory = AppDirectory, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        start.EnvironmentVariables["RELE_DATA_DIR"] = Config.DataDirectory;
        start.EnvironmentVariables["RELE_PORT"] = Config.Port.ToString();
        if (codex)
        {
            start.EnvironmentVariables.Remove("RELE_DESKTOP_CLI");
        }
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
            using (var job = background || command == "--rele-desktop-check" || command == "--rele-desktop-setup" ? new ChildJob(process) : null)
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
            // Native Codex explicitly breaks away into its own installed daemon; owned stdio stays in its nested Job.
            var limits = new Limits(); limits.Basic.Flags = 0x2000 | 0x800;
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
