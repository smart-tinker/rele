using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Principal;
using System.Threading;
using System.Windows.Forms;
using ComTypes = System.Runtime.InteropServices.ComTypes;

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
    [ComImport, Guid("4F6996D5-D7B1-412C-B0FF-063718566907"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface RdpNonScriptable5
    {
        // 50 inherited methods + 10 preceding v5 methods. Never call these placeholders.
        // The inbox type library must confirm the setter's complete ABI before it is called.
        void Slot00(); void Slot01(); void Slot02();
        void Slot03(); void Slot04(); void Slot05();
        void Slot06(); void Slot07(); void Slot08();
        void Slot09(); void Slot10(); void Slot11();
        void Slot12(); void Slot13(); void Slot14();
        void Slot15(); void Slot16(); void Slot17();
        void Slot18(); void Slot19(); void Slot20();
        void Slot21(); void Slot22(); void Slot23();
        void Slot24(); void Slot25(); void Slot26();
        void Slot27(); void Slot28(); void Slot29();
        void Slot30(); void Slot31(); void Slot32();
        void Slot33(); void Slot34(); void Slot35();
        void Slot36(); void Slot37(); void Slot38();
        void Slot39(); void Slot40(); void Slot41();
        void Slot42(); void Slot43(); void Slot44();
        void Slot45(); void Slot46(); void Slot47();
        void Slot48(); void Slot49(); void Slot50();
        void Slot51(); void Slot52(); void Slot53();
        void Slot54(); void Slot55(); void Slot56();
        void Slot57(); void Slot58(); void Slot59();
        [PreserveSig] int put_AllowPromptingForCredentials([In, MarshalAs(UnmanagedType.VariantBool)] bool allow);
    }

    [DllImport("oleaut32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, PreserveSig = false)]
    private static extern void LoadTypeLibEx(string file, int registration, out ComTypes.ITypeLib library);

    private void DisableCredentialPrompts(object client)
    {
        ComTypes.ITypeLib library = null; ComTypes.ITypeInfo info = null;
        IntPtr libraryAttr = IntPtr.Zero, typeAttr = IntPtr.Zero;
        try
        {
            credentialPromptPolicyStage = 1;
            LoadTypeLibEx(System.IO.Path.Combine(Environment.SystemDirectory, "mstscax.dll"), 2, out library); // REGKIND_NONE
            library.GetLibAttr(out libraryAttr);
            if (((ComTypes.TYPELIBATTR)Marshal.PtrToStructure(libraryAttr, typeof(ComTypes.TYPELIBATTR))).guid != new Guid("8C11EFA1-92C3-11D1-BC1E-00C04FA31489"))
                throw new InvalidOperationException("Unexpected inbox RDP type library.");
            Guid iid = typeof(RdpNonScriptable5).GUID; library.GetTypeInfoOfGuid(ref iid, out info); info.GetTypeAttr(out typeAttr);
            var type = (ComTypes.TYPEATTR)Marshal.PtrToStructure(typeAttr, typeof(ComTypes.TYPEATTR));
            if (type.guid != iid || type.typekind != ComTypes.TYPEKIND.TKIND_INTERFACE || type.cbSizeVft != 65 * IntPtr.Size)
                throw new InvalidOperationException("Unexpected RDP nonscriptable interface layout.");
            credentialPromptPolicyStage = 2;
            bool found = false;
            for (int i = 0; i < type.cFuncs; i++)
            {
                IntPtr descriptor; info.GetFuncDesc(i, out descriptor);
                try
                {
                    var function = (ComTypes.FUNCDESC)Marshal.PtrToStructure(descriptor, typeof(ComTypes.FUNCDESC));
                    string[] names = new string[1]; int count; info.GetNames(function.memid, names, 1, out count);
                    if (count != 1 || names[0] != "AllowPromptingForCredentials" || function.invkind != ComTypes.INVOKEKIND.INVOKE_PROPERTYPUT) continue;
                    if (found || function.oVft != 63 * IntPtr.Size || function.callconv != ComTypes.CALLCONV.CC_STDCALL || function.cParams != 1 || function.cParamsOpt != 0 || function.lprgelemdescParam == IntPtr.Zero || function.elemdescFunc.tdesc.vt != (short)VarEnum.VT_HRESULT ||
                        (function.funckind != ComTypes.FUNCKIND.FUNC_VIRTUAL && function.funckind != ComTypes.FUNCKIND.FUNC_PUREVIRTUAL))
                        throw new InvalidOperationException("Unexpected RDP credential prompt setter ABI.");
                    var parameter = (ComTypes.ELEMDESC)Marshal.PtrToStructure(function.lprgelemdescParam, typeof(ComTypes.ELEMDESC));
                    if (parameter.tdesc.vt != (short)VarEnum.VT_BOOL || parameter.desc.paramdesc.wParamFlags != ComTypes.PARAMFLAG.PARAMFLAG_FIN)
                        throw new InvalidOperationException("Unexpected RDP credential prompt setter parameter.");
                    found = true;
                }
                finally { info.ReleaseFuncDesc(descriptor); }
            }
            if (!found) throw new InvalidOperationException("The inbox RDP credential prompt setter is unavailable.");
            credentialPromptPolicyStage = 3;
            Marshal.ThrowExceptionForHR(((RdpNonScriptable5)client).put_AllowPromptingForCredentials(false));
            credentialPromptPolicyStage = 4;
        }
        finally
        {
            if (typeAttr != IntPtr.Zero) info.ReleaseTypeAttr(typeAttr);
            if (libraryAttr != IntPtr.Zero) library.ReleaseTLibAttr(libraryAttr);
            if (info != null) Marshal.ReleaseComObject(info);
            if (library != null) Marshal.ReleaseComObject(library);
        }
    }

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
    private volatile int connected, extendedReason, credentialPromptPolicyStage;
    private readonly int[] eventCounts = new int[23];
    private volatile int phase, phaseBeforeClose, disconnectedCode, fatalCode, logonCode, ownWtsCount, ownWtsState = -1, closeStatus = -1, closeError;
    private volatile bool disposeRequested, closeConfirmed;
    public int SessionId { get; private set; }
    public Dictionary<string, int> Diagnostics { get { return new Dictionary<string, int> {
        { "phase", phase }, { "phaseBeforeClose", phaseBeforeClose }, { "connected", connected }, { "extendedReason", extendedReason }, { "credentialPromptPolicyStage", credentialPromptPolicyStage }, { "connectingCount", eventCounts[1] }, { "connectedCount", eventCounts[2] }, { "loginCompleteCount", eventCounts[3] }, { "loginCompleteSeen", eventCounts[3] == 0 ? 0 : 1 },
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
                        DisableCredentialPrompts(host.Client);
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
