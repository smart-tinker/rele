using System;
using System.IO;
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

    private static int Main(string[] args)
    {
        IntPtr process = IntPtr.Zero, token = IntPtr.Zero;
        try
        {
            int pid;
            if (args.Length != 2 || !Int32.TryParse(args[0], out pid) || pid <= 0) throw new InvalidOperationException();
            process = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION, never termination or write access.
            if (process == IntPtr.Zero) throw new InvalidOperationException();
            var image = new StringBuilder(32768); int length = image.Capacity;
            if (!QueryFullProcessImageName(process, 0, image, ref length) || !String.Equals(Canonical(image.ToString()), Canonical(args[1]), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException();
            if (!OpenProcessToken(process, 0x0008, out token)) throw new InvalidOperationException(); // TOKEN_QUERY only.
            Elevation elevation; int required;
            if (!GetTokenInformation(token, 20, out elevation, Marshal.SizeOf(typeof(Elevation)), out required)) throw new InvalidOperationException();
            Console.WriteLine(elevation.Elevated == 0 ? "{\"elevated\":false}" : "{\"elevated\":true}");
            return 0;
        }
        catch { Console.Error.WriteLine("Fixture process identity or token elevation could not be verified."); return 1; }
        finally { if (token != IntPtr.Zero) CloseHandle(token); if (process != IntPtr.Zero) CloseHandle(process); }
    }
}
