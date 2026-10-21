using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;

// A console entry for Desktop and interactive CLI; Codex owns the daemon, this process owns no Job.
internal static class Codex
{
    private static int Main(string[] args)
    {
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            var start = new ProcessStartInfo(Path.Combine(root, "runtime", "node.exe")) { UseShellExecute = false, WorkingDirectory = root };
            var command = new StringBuilder(Quote(Path.Combine(root, "dist", "server", "codex-cli.js")));
            foreach (string arg in args) command.Append(' ').Append(Quote(arg));
            start.Arguments = command.ToString();
            string settingsPath = Path.Combine(root, "rele-install.json");
            if (File.Exists(settingsPath))
            {
                var settings = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(settingsPath));
                object value;
                if (settings.TryGetValue("OwnerSid", out value) && value != null && (string)value != WindowsIdentity.GetCurrent().User.Value)
                    throw new InvalidOperationException("Эта установка Rele принадлежит другой учётной записи.");
                if (settings.TryGetValue("DataDirectory", out value) && value is string) start.EnvironmentVariables["RELE_DATA_DIR"] = (string)value;
                if (settings.TryGetValue("CodexHome", out value) && value is string && !String.IsNullOrEmpty((string)value)) start.EnvironmentVariables["CODEX_HOME"] = (string)value;
            }
            using (var child = Process.Start(start)) { child.WaitForExit(); return child.ExitCode; }
        }
        catch { Console.Error.WriteLine("Rele: не удалось подключить общий Codex. Проверьте установку и настройки Rele."); return 1; }
    }

    private static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') result.Append('\\', slashes * 2 + 1);
            else result.Append('\\', slashes);
            result.Append(character); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
}
