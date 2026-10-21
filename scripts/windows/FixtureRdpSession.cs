using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Principal;
using System.Threading;
using System.Windows.Forms;

[ComVisible(true), Guid("336D5562-EFA8-482E-8CB3-C5C0FC7A7DB6"), InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
public interface IFixtureRdpEvents
{
    [DispId(1)] void OnConnecting(); [DispId(2)] void OnConnected(); [DispId(3)] void OnLoginComplete();
    [DispId(4)] void OnDisconnected(int reason); [DispId(10)] void OnFatalError(int code); [DispId(22)] void OnLogonError(int code);
    [DispId(15)] void OnConfirmClose([Out, MarshalAs(UnmanagedType.VariantBool)] out bool allowClose);
}
[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
public sealed class FixtureRdpEvents : IFixtureRdpEvents
{
    private readonly Action<int, int> record; private readonly Func<bool> disposing;
    public FixtureRdpEvents(Action<int, int> record, Func<bool> disposing) { this.record = record; this.disposing = disposing; }
    public void OnConnecting() { record(1, 0); } public void OnConnected() { record(2, 0); } public void OnLoginComplete() { record(3, 0); }
    public void OnDisconnected(int code) { record(4, code); } public void OnFatalError(int code) { record(10, code); } public void OnLogonError(int code) { record(22, code); }
    public void OnConfirmClose(out bool allowClose) { allowClose = disposing(); record(15, allowClose ? 1 : 0); }
}

// Disposable CI-only loopback client. Credentials never leave this process's memory.
public sealed class FixtureRdpSession : IDisposable
{
    private sealed class RdpHost : AxHost
    {
        internal RdpHost() : base("8B918B82-7985-4C24-89DF-C33AD2BBFBCD") { }
        internal object Client { get { return GetOcx(); } }
        private ConnectionPointCookie cookie; private FixtureRdpEvents sink;
        internal void Observe(Action<int, int> record, Func<bool> disposing) { sink = new FixtureRdpEvents(record, disposing); cookie = new ConnectionPointCookie(Client, sink, typeof(IFixtureRdpEvents)); }
        protected override void DetachSink() { if (cookie != null) { cookie.Disconnect(); cookie = null; } sink = null; base.DetachSink(); }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Session { internal int Id; internal IntPtr Name; internal int State; }
    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSEnumerateSessionsW(IntPtr server, int reserved, int version, out IntPtr sessions, out int count);
    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSQuerySessionInformationW(IntPtr server, int session, int kind, out IntPtr value, out int bytes);
    [DllImport("wtsapi32.dll")]
    private static extern void WTSFreeMemory(IntPtr value);
    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSLogoffSession(IntPtr server, int session, bool wait);

    private readonly string user, domain, sid;
    private readonly int parentSession = Process.GetCurrentProcess().SessionId;
    private readonly HashSet<int> baseline = new HashSet<int>();
    private readonly ManualResetEvent ready = new ManualResetEvent(false);
    private readonly Thread thread;
    private SecureString password;
    private Form form;
    private Exception failure;
    private volatile int connected, extendedReason;
    private readonly int[] eventCounts = new int[23];
    private volatile int phase, phaseBeforeClose, disconnectedCode, fatalCode, logonCode, ownWtsCount, ownWtsState = -1, closeStatus = -1, closeError;
    private volatile bool disposeRequested, closeConfirmed;
    public int SessionId { get; private set; }
    public Dictionary<string, int> Diagnostics { get { return new Dictionary<string, int> {
        { "phase", phase }, { "phaseBeforeClose", phaseBeforeClose }, { "connected", connected }, { "extendedReason", extendedReason }, { "connectingCount", eventCounts[1] }, { "connectedCount", eventCounts[2] }, { "loginCompleteCount", eventCounts[3] }, { "loginCompleteSeen", eventCounts[3] == 0 ? 0 : 1 },
        { "disconnectedCount", eventCounts[4] }, { "disconnectedCode", disconnectedCode }, { "fatalCount", eventCounts[10] }, { "fatalCode", fatalCode }, { "logonCount", eventCounts[22] }, { "logonCode", logonCode },
        { "ownWtsCount", ownWtsCount }, { "ownWtsState", ownWtsState }, { "confirmCloseCount", eventCounts[15] }, { "closeConfirmed", closeConfirmed ? 1 : 0 }, { "closeStatus", closeStatus }, { "closeErrorHResult", closeError } }; } }
    private void Record(int id, int code) { phase = id; Interlocked.Increment(ref eventCounts[id]); if (id == 4) disconnectedCode = code; if (id == 10) fatalCode = code; if (id == 22) logonCode = code; if (id == 15 && code == 1) closeConfirmed = true; }

    public FixtureRdpSession(string user, string domain, SecureString password, string sid)
    {
        if (new SecurityIdentifier(sid).Equals(WindowsIdentity.GetCurrent().User)) throw new InvalidOperationException("The RDP fixture must use a different user.");
        this.user = user; this.domain = domain; this.password = password.Copy(); this.sid = sid; SessionId = -1;
        foreach (Session session in Sessions()) baseline.Add(session.Id);
        thread = new Thread(Run); thread.IsBackground = true; thread.SetApartmentState(ApartmentState.STA);
    }

    public void Connect()
    {
        thread.Start();
        if (!ready.WaitOne(60000)) throw new InvalidOperationException("Loopback RDP did not create the isolated user's active session; connected=" + connected + "; extendedReason=" + extendedReason + ".");
        if (failure != null) throw new InvalidOperationException("Loopback RDP initialization failed; HRESULT=0x" + failure.HResult.ToString("X8") + ".");
    }

    private void Run()
    {
        try
        {
            using (var window = new Form())
            using (var host = new RdpHost())
            using (var timer = new System.Windows.Forms.Timer())
            {
                form = window; window.ShowInTaskbar = false; window.StartPosition = FormStartPosition.Manual;
                window.Location = new Point(-32000, -32000); window.Size = new Size(800, 600);
                host.Dock = DockStyle.Fill; window.Controls.Add(host); timer.Interval = 200;
                window.Shown += delegate
                {
                    try
                    {
                        dynamic client = host.Client;
                        host.Observe(Record, delegate { return disposeRequested; });
                        client.Server = "127.0.0.1"; client.UserName = user; client.Domain = domain;
                        client.DesktopWidth = 800; client.DesktopHeight = 600;
                        dynamic settings = client.AdvancedSettings9;
                        settings.EnableCredSspSupport = true;
                        // Trust only this fixed loopback control's self-signed server; keep NLA enabled.
                        settings.AuthenticationLevel = 0;
                        IntPtr secret = Marshal.SecureStringToBSTR(password);
                        try { settings.ClearTextPassword = Marshal.PtrToStringBSTR(secret); }
                        finally { Marshal.ZeroFreeBSTR(secret); password.Dispose(); password = null; }
                        client.Connect(); timer.Start();
                    }
                    catch (Exception error) { failure = error; ready.Set(); window.Close(); }
                };
                timer.Tick += delegate
                {
                    try
                    {
                        dynamic client = host.Client; connected = (int)client.Connected; extendedReason = (int)client.ExtendedDisconnectReason;
                        if (disposeRequested) { if (connected == 0 || closeConfirmed) window.Close(); return; }
                        int count = 0;
                        foreach (Session session in Sessions())
                            if (Owned(session.Id)) { count++; ownWtsState = session.State; if (session.State == 0) { SessionId = session.Id; ready.Set(); } }
                        ownWtsCount = count;
                    }
                    catch (Exception error) { failure = error; ready.Set(); window.Close(); }
                };
                Application.Run(window);
            }
        }
        catch (Exception error) { failure = error; ready.Set(); }
        finally { if (password != null) { password.Dispose(); password = null; } }
    }

    private static List<Session> Sessions()
    {
        IntPtr buffer; int count;
        if (!WTSEnumerateSessionsW(IntPtr.Zero, 0, 1, out buffer, out count)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var result = new List<Session>(); int size = Marshal.SizeOf(typeof(Session));
            for (int i = 0; i < count; i++) result.Add((Session)Marshal.PtrToStructure(IntPtr.Add(buffer, i * size), typeof(Session)));
            return result;
        }
        finally { WTSFreeMemory(buffer); }
    }

    private static string QueryString(int session, int kind)
    {
        IntPtr value; int bytes;
        if (!WTSQuerySessionInformationW(IntPtr.Zero, session, kind, out value, out bytes)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try { return Marshal.PtrToStringUni(value) ?? ""; } finally { WTSFreeMemory(value); }
    }

    private bool Owned(int session)
    {
        if (session == parentSession || baseline.Contains(session)) return false;
        IntPtr value; int bytes;
        if (!WTSQuerySessionInformationW(IntPtr.Zero, session, 16, out value, out bytes)) return false;
        try { if (bytes < 2 || Marshal.ReadInt16(value) != 2) return false; } finally { WTSFreeMemory(value); }
        string name = QueryString(session, 5), ownerDomain = QueryString(session, 7);
        if (name.Length == 0) return false;
        return ((SecurityIdentifier)new NTAccount(ownerDomain, name).Translate(typeof(SecurityIdentifier))).Value == sid;
    }

    public void Dispose()
    {
        phaseBeforeClose = phase; disposeRequested = true;
        try { if (form != null && form.IsHandleCreated) form.BeginInvoke((Action)delegate {
            try { dynamic client = ((RdpHost)form.Controls[0]).Client; closeStatus = (int)client.RequestClose(); if (closeStatus == 0) form.Close(); }
            catch (Exception error) { closeError = error.HResult; form.Close(); }
        }); } catch (InvalidOperationException) { }
        bool hostStopped = !thread.IsAlive || thread.Join(5000);
        foreach (Session session in Sessions())
        {
            if (!Owned(session.Id)) continue;
            // Revalidate the SID, RDP protocol, and baseline immediately before logging off.
            if (!Owned(session.Id)) continue;
            if (!WTSLogoffSession(IntPtr.Zero, session.Id, false)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        DateTime deadline = DateTime.UtcNow.AddSeconds(10);
        while (Sessions().Exists(delegate(Session session) { return Owned(session.Id); }))
        {
            if (DateTime.UtcNow >= deadline) throw new InvalidOperationException("The isolated RDP fixture session did not log off.");
            Thread.Sleep(100);
        }
        if (!hostStopped) throw new InvalidOperationException("The loopback RDP host did not close.");
        ready.Dispose();
    }
}
