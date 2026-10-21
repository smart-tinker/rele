using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Principal;
using System.Text;
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
    [StructLayout(LayoutKind.Sequential)]
    private struct PolicyAttributes { internal uint Length; internal IntPtr RootDirectory, ObjectName; internal uint Attributes; internal IntPtr SecurityDescriptor, SecurityQualityOfService; }
    [StructLayout(LayoutKind.Sequential)]
    private struct PolicyString { internal ushort Length, MaximumLength; internal IntPtr Buffer; }
    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern uint LsaOpenPolicy(IntPtr system, ref PolicyAttributes attributes, uint access, out IntPtr policy);
    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern uint LsaEnumerateAccountRights(IntPtr policy, [In] byte[] sid, out IntPtr rights, out uint count);
    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern uint LsaFreeMemory(IntPtr memory);
    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern uint LsaClose(IntPtr policy);

    public static Dictionary<string, object> ReadRemoteLogonRights(string freshSid)
    {
        var identity = new SecurityIdentifier(freshSid);
        if (!identity.IsAccountSid() || identity.Equals(WindowsIdentity.GetCurrent().User)) throw new InvalidOperationException("Expected the isolated fixture account SID.");
        // Fixed principals: 0=fresh user, 1=Users, 2=RDP Users, 3=Everyone,
        // 4=Authenticated Users, 5=Local Account, 6=Interactive, 7=Remote Interactive.
        // Direct assignment facts only; this is not an effective-access calculation.
        string[] principals = { freshSid, "S-1-5-32-545", "S-1-5-32-555", "S-1-1-0", "S-1-5-11", "S-1-5-113", "S-1-5-4", "S-1-5-14" };
        var facts = new List<Dictionary<string, object>>();
        var result = new Dictionary<string, object> { { "principals", facts } };
        var attributes = new PolicyAttributes { Length = (uint)Marshal.SizeOf(typeof(PolicyAttributes)) };
        IntPtr policy = IntPtr.Zero; uint opened = LsaOpenPolicy(IntPtr.Zero, ref attributes, 0x800, out policy); // POLICY_LOOKUP_NAMES only.
        result["policyStatus"] = opened;
        try
        {
            if (opened != 0) return result;
            int size = Marshal.SizeOf(typeof(PolicyString));
            for (int index = 0; index < principals.Length; index++)
            {
                var principal = new SecurityIdentifier(principals[index]); byte[] binary = new byte[principal.BinaryLength]; principal.GetBinaryForm(binary, 0);
                IntPtr rights = IntPtr.Zero; uint count;
                var record = new Dictionary<string, object> { { "principal", index }, { "allowAssigned", null }, { "denyAssigned", null } }; facts.Add(record);
                try
                {
                    uint status = LsaEnumerateAccountRights(policy, binary, out rights, out count);
                    record["queryStatus"] = status;
                    // No LSA account object means no directly assigned rights; other failures remain unknown.
                    if (status == 0xC0000034) { record["rightsCount"] = 0; record["noAssignments"] = true; record["allowAssigned"] = false; record["denyAssigned"] = false; continue; }
                    if (status != 0) continue;
                    if (count > 256 || (count != 0 && rights == IntPtr.Zero)) throw new InvalidOperationException("Invalid LSA rights array.");
                    record["rightsCount"] = count;
                    bool allow = false, deny = false;
                    for (int item = 0; item < count; item++)
                    {
                        var right = (PolicyString)Marshal.PtrToStructure(IntPtr.Add(rights, item * size), typeof(PolicyString));
                        if (right.Length > 1024 || right.Length % 2 != 0 || right.Length > right.MaximumLength || (right.Length != 0 && right.Buffer == IntPtr.Zero)) throw new InvalidOperationException("Invalid LSA right string.");
                        string name = right.Length == 0 ? "" : Marshal.PtrToStringUni(right.Buffer, right.Length / 2);
                        if (name == "SeRemoteInteractiveLogonRight") allow = true;
                        if (name == "SeDenyRemoteInteractiveLogonRight") deny = true;
                    }
                    record["allowAssigned"] = allow; record["denyAssigned"] = deny;
                }
                finally { if (rights != IntPtr.Zero) { uint status = LsaFreeMemory(rights); if (status != 0) record["freeStatus"] = status; } }
            }
            return result;
        }
        finally { if (opened == 0 && policy != IntPtr.Zero) { uint status = LsaClose(policy); if (status != 0) result["closeStatus"] = status; } }
    }

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

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SavedCredential
    {
        internal uint Flags, Type; internal string TargetName, Comment; internal ComTypes.FILETIME LastWritten;
        internal uint CredentialBlobSize; internal IntPtr CredentialBlob; internal uint Persist, AttributeCount;
        internal IntPtr Attributes; internal string TargetAlias, UserName;
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool CredWriteW([In] ref SavedCredential credential, uint flags);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool CredDeleteW(string target, uint type, uint flags);
    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern void CredFree(IntPtr credential);
    private delegate bool WindowCallback(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern bool EnumChildWindows(IntPtr parent, WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern IntPtr GetParent(IntPtr window);
    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern IntPtr GetDlgItem(IntPtr dialog, int id);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int GetClassNameW(IntPtr window, StringBuilder name, int capacity);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int GetWindowTextW(IntPtr window, StringBuilder text, int capacity);
    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr SendMessageTimeoutW(IntPtr window, uint message, UIntPtr capacity, StringBuilder text, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr SendCertificateClick(IntPtr window, uint message, UIntPtr parameter, IntPtr value, uint flags, uint timeout, out UIntPtr result);
    private const string CredentialTarget = "TERMSRV/127.0.0.1";
    private bool mstscControl, credentialOwned;
    private string credentialComment;
    private Process mstsc;
    private int mstscPid, mstscGuiError;
    private int certificatePromptSeen, certificateYesCount, certificateClickCount, certificateClickDelivered, certificateConfirmed;
    private IntPtr certificateDialog;
    private readonly List<Dictionary<string, object>> mstscWindows = new List<Dictionary<string, object>>();
    public List<Dictionary<string, object>> MstscWindows { get { return mstscWindows; } }

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
        { "ownWtsCount", ownWtsCount }, { "ownWtsState", ownWtsState }, { "confirmCloseCount", eventCounts[15] }, { "closeConfirmed", closeConfirmed ? 1 : 0 }, { "closeStatus", closeStatus }, { "closeErrorHResult", closeError }, { "mstscControl", mstscControl ? 1 : 0 }, { "mstscPid", mstscPid }, { "mstscGuiErrorHResult", mstscGuiError },
        { "mstscCertificatePromptSeen", certificatePromptSeen }, { "mstscCertificateYesCount", certificateYesCount }, { "mstscCertificateClickCount", certificateClickCount }, { "mstscCertificateClickDelivered", certificateClickDelivered }, { "mstscCertificateConfirmed", certificateConfirmed } }; } }
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

    public void ConnectMstsc(string fixtureRoot, string nonce)
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(60);
        mstscControl = true;
        Guid parsed; string root = Path.GetFullPath(fixtureRoot), drive = Path.GetPathRoot(root);
        if (!Guid.TryParseExact(nonce, "N", out parsed) || drive.Length != 3 || drive[1] != ':' ||
            root != Path.Combine(drive, "rc-" + nonce.Substring(0, 8)) || user != "ReleCi" + nonce.Substring(0, 8) || !string.Equals(domain, Environment.MachineName, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Invalid isolated mstsc fixture.");
        if (IntPtr.Size != 8 || Marshal.SizeOf(typeof(SavedCredential)) != 80) throw new InvalidOperationException("Unexpected Windows credential ABI.");
        credentialComment = "Rele-CI-" + nonce;
        // Refuse both password credential types; never overwrite a pre-existing loopback entry.
        foreach (uint type in new uint[] { 1, 2 })
        {
            IntPtr existing;
            if (CredReadW(CredentialTarget, type, 0, out existing)) { CredFree(existing); throw new InvalidOperationException("A loopback RDP credential already exists."); }
            int error = Marshal.GetLastWin32Error(); if (error != 1168) throw new System.ComponentModel.Win32Exception(error);
        }
        IntPtr secret = Marshal.SecureStringToGlobalAllocUnicode(password);
        try
        {
            var credential = new SavedCredential { Type = 1, TargetName = CredentialTarget, Comment = credentialComment,
                UserName = domain + "\\" + user, Persist = 1, CredentialBlob = secret, CredentialBlobSize = checked((uint)password.Length * 2) };
            if (!CredWriteW(ref credential, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            credentialOwned = true;
        }
        finally { Marshal.ZeroFreeGlobalAllocUnicode(secret); password.Dispose(); password = null; }
        mstsc = Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "mstsc.exe"), "/v:127.0.0.1") { UseShellExecute = false, WorkingDirectory = root });
        mstscPid = mstsc.Id;
        while (DateTime.UtcNow < deadline)
        {
            ConfirmMstscCertificate(deadline);
            if (DateTime.UtcNow >= deadline) break;
            int count = 0;
            foreach (Session session in Sessions())
                if (Owned(session.Id)) { count++; ownWtsState = session.State; if (session.State == 0) SessionId = session.Id; }
            ownWtsCount = count;
            if (SessionId >= 0) return;
            if (mstsc.HasExited) throw new InvalidOperationException("The owned mstsc client exited before the isolated RDP session was active; exitCode=" + mstsc.ExitCode + ".");
            Thread.Sleep(200);
        }
        CaptureMstscWindows();
        throw new InvalidOperationException("The mstsc control did not create the isolated user's active RDP session.");
    }

    private bool OwnedVisibleWindow(IntPtr window, string expectedClass)
    {
        uint owner; GetWindowThreadProcessId(window, out owner);
        if (owner != mstscPid || !IsWindowVisible(window)) return false;
        var name = new StringBuilder(80); GetClassNameW(window, name, name.Capacity);
        return name.ToString() == expectedClass;
    }

    private string MstscLabel(IntPtr window, string expectedClass)
    {
        if ((expectedClass != "Static" && expectedClass != "Button") || !OwnedVisibleWindow(window, expectedClass)) return null;
        var text = new StringBuilder(161); UIntPtr copied;
        return SendMessageTimeoutW(window, 0x000D, new UIntPtr((uint)text.Capacity), text, 0x0003, 100, out copied) == IntPtr.Zero ? null : text.ToString();
    }

    private bool IsMstscCertificateDialog(IntPtr window)
    {
        if (!OwnedVisibleWindow(window, "#32770")) return false;
        var title = new StringBuilder(161); GetWindowTextW(window, title, title.Capacity);
        return title.ToString() == "Remote Desktop Connection" &&
            MstscLabel(GetDlgItem(window, 14001), "Static") == "The remote computer could not be authenticated due to problems with its security certificate. It may be unsafe to proceed." &&
            MstscLabel(GetDlgItem(window, 13444), "Static") == "The certificate is not from a trusted certifying authority." &&
            MstscLabel(GetDlgItem(window, 13449), "Static") == "Do you want to connect despite these certificate errors?";
    }

    private void ConfirmMstscCertificate(DateTime deadline)
    {
        if (certificateClickCount != 0) { if (!IsWindowVisible(certificateDialog)) certificateConfirmed = 1; return; }
        var dialogs = new List<IntPtr>(); int windows = 0; bool complete = true;
        EnumWindows(delegate(IntPtr window, IntPtr unused)
        {
            if (DateTime.UtcNow >= deadline) { complete = false; return false; }
            uint owner; GetWindowThreadProcessId(window, out owner); if (owner != mstscPid) return true;
            if (++windows > 16) { complete = false; return false; }
            if (IsMstscCertificateDialog(window)) dialogs.Add(window);
            return true;
        }, IntPtr.Zero);
        if (dialogs.Count == 0) return;
        certificatePromptSeen = 1;
        if (!complete || dialogs.Count != 1) { CaptureMstscWindows(); throw new InvalidOperationException("The owned mstsc certificate dialog was ambiguous."); }
        IntPtr dialog = dialogs[0]; var buttons = new List<IntPtr>(); int children = 0;
        EnumChildWindows(dialog, delegate(IntPtr child, IntPtr unused)
        {
            if (++children > 64 || DateTime.UtcNow >= deadline) { complete = false; return false; }
            if (GetParent(child) != dialog || !OwnedVisibleWindow(child, "Button") || !IsWindowEnabled(child)) return true;
            string text = MstscLabel(child, "Button"); if (text == "Yes" || text == "&Yes") buttons.Add(child);
            return true;
        }, IntPtr.Zero);
        certificateYesCount = buttons.Count;
        if (!complete || buttons.Count != 1) { CaptureMstscWindows(); throw new InvalidOperationException("The owned mstsc certificate confirmation button was ambiguous."); }
        IntPtr button = buttons[0]; string label = MstscLabel(button, "Button");
        if (!IsMstscCertificateDialog(dialog) || GetParent(button) != dialog || !OwnedVisibleWindow(button, "Button") || !IsWindowEnabled(button) || (label != "Yes" && label != "&Yes"))
        { CaptureMstscWindows(); throw new InvalidOperationException("The owned mstsc certificate dialog changed before confirmation."); }
        if (DateTime.UtcNow >= deadline) return;
        certificateDialog = dialog; certificateClickCount = 1; UIntPtr ignored;
        // One click on the specifically verified loopback certificate dialog, never general dialog input.
        certificateClickDelivered = SendCertificateClick(button, 0x00F5, UIntPtr.Zero, IntPtr.Zero, 0x0003, 100, out ignored) == IntPtr.Zero ? 0 : 1; // BM_CLICK
        if (!IsWindowVisible(dialog)) certificateConfirmed = 1;
    }

    private void CaptureMstscWindows()
    {
        // Only the exact process started above; read no Edit/custom-control text and send no input.
        DateTime deadline = DateTime.UtcNow.AddSeconds(3); int childCount = 0;
        try
        {
            EnumWindows(delegate(IntPtr window, IntPtr unused)
            {
                if (mstscWindows.Count >= 4 || DateTime.UtcNow >= deadline) return false;
                uint owner; GetWindowThreadProcessId(window, out owner); if (owner != mstscPid || !IsWindowVisible(window)) return true;
                var name = new StringBuilder(80); GetClassNameW(window, name, name.Capacity);
                var title = new StringBuilder(161);
                if (name.Length != 0 && name.ToString().IndexOf("edit", StringComparison.OrdinalIgnoreCase) < 0) GetWindowTextW(window, title, title.Capacity);
                var children = new List<Dictionary<string, object>>();
                mstscWindows.Add(new Dictionary<string, object> { { "class", name.ToString() }, { "title", title.ToString() }, { "children", children } });
                EnumChildWindows(window, delegate(IntPtr child, IntPtr ignored)
                {
                    if (childCount >= 24 || DateTime.UtcNow >= deadline) return false;
                    uint childOwner; GetWindowThreadProcessId(child, out childOwner); if (childOwner != mstscPid) return true;
                    childCount++; var childClass = new StringBuilder(80); GetClassNameW(child, childClass, childClass.Capacity);
                    var record = new Dictionary<string, object> { { "class", childClass.ToString() }, { "id", GetDlgCtrlID(child) } }; children.Add(record);
                    if (childClass.ToString() == "Static" || childClass.ToString() == "Button")
                    {
                        var text = new StringBuilder(161); UIntPtr copied;
                        if (SendMessageTimeoutW(child, 0x000D, new UIntPtr((uint)text.Capacity), text, 0x0003, 100, out copied) != IntPtr.Zero) record["text"] = text.ToString();
                    }
                    return true;
                }, IntPtr.Zero);
                return true;
            }, IntPtr.Zero);
        }
        catch (Exception error) { mstscGuiError = error.HResult; }
    }

    private void DeleteMstscCredential()
    {
        if (!credentialOwned) return;
        IntPtr value;
        if (!CredReadW(CredentialTarget, 1, 0, out value)) { int error = Marshal.GetLastWin32Error(); if (error == 1168) return; throw new System.ComponentModel.Win32Exception(error); }
        try
        {
            var credential = (SavedCredential)Marshal.PtrToStructure(value, typeof(SavedCredential));
            if (credential.Type != 1 || !string.Equals(credential.TargetName, CredentialTarget, StringComparison.OrdinalIgnoreCase) || credential.Comment != credentialComment || credential.UserName != domain + "\\" + user)
                throw new InvalidOperationException("Refusing to remove a foreign loopback RDP credential.");
            if (!CredDeleteW(CredentialTarget, 1, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            credentialOwned = false;
        }
        finally { CredFree(value); }
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
                window.Location = Screen.PrimaryScreen.WorkingArea.Location; window.Size = new Size(800, 600);
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
        if (mstscControl)
        {
            try
            {
                try { if (mstsc != null) { if (!mstsc.HasExited) mstsc.Kill(); if (!mstsc.WaitForExit(5000)) throw new InvalidOperationException("The owned mstsc client did not exit."); } }
                finally { if (mstsc != null) { mstsc.Dispose(); mstsc = null; } }
            }
            finally
            {
                try { LogOffOwnedSessions(); }
                finally
                {
                    try { DeleteMstscCredential(); }
                    finally { if (password != null) { password.Dispose(); password = null; } ready.Dispose(); }
                }
            }
            return;
        }
        phaseBeforeClose = phase; disposeRequested = true;
        try { if (form != null && form.IsHandleCreated) form.BeginInvoke((Action)delegate {
            try { dynamic client = ((RdpHost)form.Controls[0]).Client; closeStatus = (int)client.RequestClose(); if (closeStatus == 0) form.Close(); }
            catch (Exception error) { closeError = error.HResult; form.Close(); }
        }); } catch (InvalidOperationException) { }
        bool hostStopped = !thread.IsAlive || thread.Join(5000);
        LogOffOwnedSessions();
        if (!hostStopped) throw new InvalidOperationException("The loopback RDP host did not close.");
        ready.Dispose();
    }

    private void LogOffOwnedSessions()
    {
        var loggingOff = new HashSet<int>();
        foreach (Session session in Sessions())
        {
            if (!Owned(session.Id)) continue;
            // Revalidate the SID, RDP protocol, and baseline immediately before logging off.
            if (!Owned(session.Id)) continue;
            if (!WTSLogoffSession(IntPtr.Zero, session.Id, false)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            loggingOff.Add(session.Id);
        }
        DateTime deadline = DateTime.UtcNow.AddSeconds(10);
        // A logging-off session can clear its username before it has terminated.
        // Wait for the exact sessions we logged off, independently of their changing owner metadata.
        while (Sessions().Exists(delegate(Session session) { return loggingOff.Contains(session.Id); }))
        {
            if (DateTime.UtcNow >= deadline) throw new InvalidOperationException("The isolated RDP fixture session did not log off.");
            Thread.Sleep(100);
        }
    }
}
