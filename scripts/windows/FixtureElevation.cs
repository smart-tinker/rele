using System;
using System.IO;
using System.Diagnostics;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Text;

// Disposable CI metadata probe: query only the verified fixture's executable and token elevation.
internal static class FixtureElevation
{
    [StructLayout(LayoutKind.Sequential)] private struct Elevation { public int Elevated; }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref int size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetLongPathName(string path, StringBuilder result, uint length);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int kind, out Elevation value, int size, out int required);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);

    private static string Canonical(string path)
    {
        var result = new StringBuilder(32768);
        uint size = GetLongPathName(Path.GetFullPath(path), result, (uint)result.Capacity);
        if (size == 0 || size >= result.Capacity) throw new InvalidOperationException();
        return result.ToString();
    }

    private static bool ReadElevation(int pid, string expectedImage)
    {
        IntPtr process = IntPtr.Zero, token = IntPtr.Zero;
        try
        {
            process = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION, never termination or write access.
            if (process == IntPtr.Zero) throw new InvalidOperationException();
            var image = new StringBuilder(32768); int length = image.Capacity;
            if (!QueryFullProcessImageName(process, 0, image, ref length) || !String.Equals(Canonical(image.ToString()), Canonical(expectedImage), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException();
            if (!OpenProcessToken(process, 0x0008, out token)) throw new InvalidOperationException(); // TOKEN_QUERY only.
            Elevation elevation; int required;
            if (!GetTokenInformation(token, 20, out elevation, Marshal.SizeOf(typeof(Elevation)), out required)) throw new InvalidOperationException();
            return elevation.Elevated != 0;
        }
        finally { if (token != IntPtr.Zero) CloseHandle(token); if (process != IntPtr.Zero) CloseHandle(process); }
    }

    private static int Main(string[] args)
    {
        string root = null, stage = "scope";
        try
        {
            if (args.Length == 4 && args[0] == "--canary")
            {
                Guid nonce;
                if (!Guid.TryParseExact(args[2], "N", out nonce) || !Path.IsPathRooted(args[1]) || Path.GetPathRoot(args[1]).Length != 3 || args[1][1] != ':' || (args[1][2] != '\\' && args[1][2] != '/')) throw new InvalidOperationException();
                string candidate = Canonical(args[1]).TrimEnd(Path.DirectorySeparatorChar);
                string parent = Path.GetDirectoryName(candidate);
                if (!String.Equals(parent, Path.GetPathRoot(candidate), StringComparison.OrdinalIgnoreCase) ||
                    !String.Equals(Path.GetFileName(candidate), "rc-" + args[2].Substring(0, 8), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException();
                string image = Process.GetCurrentProcess().MainModule.FileName;
                if (!String.Equals(Canonical(image), Canonical(Path.Combine(candidate, "FixtureElevation.exe")), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException();
                stage = "sid";
                string sid = WindowsIdentity.GetCurrent().User.Value;
                if (new SecurityIdentifier(args[3]).Value != sid) throw new InvalidOperationException();
                root = candidate; stage = "token";
                if (ReadElevation(Process.GetCurrentProcess().Id, image)) throw new InvalidOperationException();
                stage = "receipt";
                using (var output = new StreamWriter(new FileStream(Path.Combine(root, "canary.json"), FileMode.CreateNew, FileAccess.Write, FileShare.None), new UTF8Encoding(false)))
                    output.Write("{\"nonce\":\"" + args[2] + "\",\"sid\":\"" + sid + "\",\"elevated\":false,\"sessionId\":" + Process.GetCurrentProcess().SessionId + "}");
                return 0;
            }
            int pid;
            if (args.Length != 2 || !Int32.TryParse(args[0], out pid) || pid <= 0) throw new InvalidOperationException();
            Console.WriteLine(ReadElevation(pid, args[1]) ? "{\"elevated\":true}" : "{\"elevated\":false}");
            return 0;
        }
        catch (Exception error)
        {
            if (root != null)
                using (var output = new StreamWriter(new FileStream(Path.Combine(root, "canary-error.json"), FileMode.CreateNew, FileAccess.Write, FileShare.None), new UTF8Encoding(false)))
                    output.Write("{\"stage\":\"" + stage + "\",\"hresult\":\"0x" + error.HResult.ToString("X8") + "\"}");
            Console.Error.WriteLine("Fixture process identity or token elevation could not be verified."); return 1;
        }
    }
}
