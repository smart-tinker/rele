param([Parameter(Mandatory = $true)][string]$SocketPath)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or -not [IO.Path]::IsPathRooted($SocketPath)) { throw 'Expected an absolute Windows fixture path' }
if ([Text.Encoding]::UTF8.GetByteCount($SocketPath) -ge 108) { throw 'Use a shorter TEMP directory for the AF_UNIX fixture' }
if (-not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($SocketPath))) { throw 'The owned socket parent must exist' }
if ([IO.File]::Exists($SocketPath) -or [IO.Directory]::Exists($SocketPath)) { throw 'The fixture path already exists' }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ReleWindowsUnixSocketFixture
{
    [DllImport("ws2_32.dll")] private static extern int WSAStartup(ushort version, [Out] byte[] data);
    [DllImport("ws2_32.dll")] private static extern int WSACleanup();
    [DllImport("ws2_32.dll")] private static extern IntPtr socket(int family, int type, int protocol);
    [DllImport("ws2_32.dll")] private static extern int bind(IntPtr handle, byte[] address, int length);
    [DllImport("ws2_32.dll")] private static extern int closesocket(IntPtr handle);
    [DllImport("ws2_32.dll")] private static extern int WSAGetLastError();

    public static void Create(string path)
    {
        int startup = WSAStartup(0x202, new byte[512]);
        if (startup != 0) throw new InvalidOperationException("Winsock fixture startup failed: " + startup);
        IntPtr handle = new IntPtr(-1);
        try
        {
            byte[] name = Encoding.UTF8.GetBytes(path);
            if (name.Length >= 108 || Array.IndexOf(name, (byte)0) >= 0) throw new InvalidOperationException("Invalid AF_UNIX fixture path");
            byte[] address = new byte[110];
            address[0] = 1; // AF_UNIX, followed by its UTF-8 path and a trailing NUL.
            Array.Copy(name, 0, address, 2, name.Length);
            handle = socket(1, 1, 0); // AF_UNIX / SOCK_STREAM; no network listener or external traffic.
            if (handle == new IntPtr(-1)) throw new InvalidOperationException("Winsock fixture socket failed: " + WSAGetLastError());
            if (bind(handle, address, address.Length) != 0) throw new InvalidOperationException("Winsock fixture bind failed: " + WSAGetLastError());
        }
        finally
        {
            if (handle != new IntPtr(-1)) closesocket(handle);
            WSACleanup();
        }
    }
}
'@
[ReleWindowsUnixSocketFixture]::Create($SocketPath)
[Console]::Out.Write('windows-unix-socket-created')
