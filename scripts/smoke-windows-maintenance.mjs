import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCSharpCompiler } from './build-process-host.mjs';

// Pure native validators against the actual launcher source: no Task, environment, server or user-profile changes.
if (process.platform !== 'win32') throw new Error('Run the native maintenance smoke on Windows.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'Rele-maintenance-'));
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
try {
  const compiler = await findCSharpCompiler();
  const library = path.join(temporary, 'Launcher.dll');
  run(compiler, ['/nologo', '/target:library', '/platform:x64', '/codepage:65001',
    '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll', '/r:System.Management.dll', '/r:Microsoft.CSharp.dll',
    `/out:${library}`, path.join(root, 'scripts/windows/Rele.cs')]);
  const source = path.join(temporary, 'Smoke.cs');
  await writeFile(source, String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
class Smoke {
 static Type launcher; static object config; static int passed; static string data;
 static JavaScriptSerializer json = new JavaScriptSerializer();
 static object Call(string name, params object[] args) { try { return launcher.GetMethod(name, BindingFlags.NonPublic|BindingFlags.Static).Invoke(null,args); } catch(TargetInvocationException e) { throw e.InnerException; } }
 static void Set(string key, object value) { config.GetType().GetProperty(key).SetValue(config,value,null); }
 static object Get(string key) { return config.GetType().GetProperty(key).GetValue(config,null); }
 static void Check(bool value) { if(!value) throw new Exception("assertion"); passed++; }
 static void Refused(string reason, Action action) {
  try { action(); throw new Exception("expected-refusal"); } catch(Exception e) {
   var field=e.GetType().GetField("ReasonCode"); if(field==null || !Object.Equals(field.GetValue(e),reason)) throw; passed++;
  }
 }
 static Dictionary<string,object> Diagnostic(params object[] gauges) { return new Dictionary<string,object>{{"process",new Dictionary<string,object>{{"id",123}}},{"gauges",gauges}}; }
 static object Gauge(string name, object value) { return new Dictionary<string,object>{{"name",name},{"value",value}}; }
 static void Idle(Dictionary<string,object> value) { Call("ValidateIdleGauges",value,123); passed++; }
 static void Marker(string directory, string previous, string force=null, string sid=null) {
  if(!Directory.Exists(directory)) Call("PrivateDirectory",directory,true);
  File.WriteAllText(Path.Combine(directory,"rele-install.json"), json.Serialize(new Dictionary<string,object>{{"DesktopAdapterVersion",1},{"OwnerSid",sid??WindowsIdentity.GetCurrent().User.Value},{"DataDirectory",data},{"PreviousCodexCliPath",previous},{"PreviousForceCli",force}}),new UTF8Encoding(false));
 }
 static string Executable(string dir) { return Path.Combine(dir,"Rele.Codex.exe"); }
 static void Main(string[] args) {
  launcher=Assembly.LoadFrom(args[0]).GetType("Rele",true); data=Path.Combine(args[1],"data"); Directory.CreateDirectory(data);
  config=Activator.CreateInstance(launcher.GetNestedType("Settings",BindingFlags.Public|BindingFlags.NonPublic));
  Set("DataDirectory",data); Set("OwnerSid",WindowsIdentity.GetCurrent().User.Value);
  launcher.GetField("Config",BindingFlags.NonPublic|BindingFlags.Static).SetValue(null,config);
  launcher.GetField("AppDirectory",BindingFlags.NonPublic|BindingFlags.Static).SetValue(null,Path.Combine(args[1],"app"));
  Idle(Diagnostic(Gauge("app.requests.in_flight",1)));
  Idle(Diagnostic(Gauge("app.requests.in_flight",1),Gauge("app.requests.queued",0),Gauge("core.threads.live",14),Gauge("mcp.connections.live",28)));
  Idle(Diagnostic(Gauge("app.requests.in_flight",1),Gauge("app.requests.queued",0),Gauge("app.server_requests.pending",0),Gauge("core.mailbox.pending",0),Gauge("core.threads.live",14),Gauge("core.turns.active",0),Gauge("mcp.connections.live",28)));
  foreach(string key in new[]{"app.requests.queued","app.server_requests.pending","core.mailbox.pending","core.turns.active"}) Refused("busy",()=>Call("ValidateIdleGauges",Diagnostic(Gauge("app.requests.in_flight",1),Gauge(key,1)),123));
  Refused("busy",()=>Call("ValidateIdleGauges",Diagnostic(Gauge("app.requests.in_flight",2)),123));
  Refused("unsupported-diagnostics",()=>Call("ValidateIdleGauges",Diagnostic(),123));
  Refused("unsupported-diagnostics",()=>Call("ValidateIdleGauges",Diagnostic(Gauge("app.requests.in_flight",1),Gauge("unknown.counter",0)),123));
  Refused("unsupported-diagnostics",()=>Call("ValidateIdleGauges",Diagnostic(Gauge("app.requests.in_flight",1),Gauge("app.requests.in_flight",1)),123));
  foreach(object invalid in new object[]{-1,0.5,Double.NaN,Double.PositiveInfinity,"0",true,9007199254740992d}) Refused("unsupported-diagnostics",()=>Call("ValidateIdleGauges",Diagnostic(Gauge("app.requests.in_flight",1),Gauge("core.threads.live",invalid)),123));
  Refused("uncertain",()=>Call("ValidateIdleGauges",Diagnostic(Gauge("app.requests.in_flight",1)),124));
  string cache=Path.Combine(data,"codex-adapters"),a=Path.Combine(cache,new string('a',64)),b=Path.Combine(cache,new string('b',64));
  try { Call("PathRefers",Path.Combine(args[1],"absent~1","Rele.Codex.exe"),a); throw new Exception("unresolved-alias-allowed"); }
  catch(InvalidOperationException e) { Check(e.GetType().Name=="AdapterAliasException"); }
  Marker(a,Executable(b)); Marker(b,"foreign-codex","0"); Set("PreviousCodexCliPath",Executable(a)); Set("PreviousForceCli","1");
  Check((bool)Call("FlattenLegacyPrevious") && (string)Get("PreviousCodexCliPath")=="foreign-codex" && (string)Get("PreviousForceCli")=="0");
  Marker(b,null); Set("PreviousCodexCliPath",Executable(a)); Check((bool)Call("FlattenLegacyPrevious") && Get("PreviousCodexCliPath")==null && Get("PreviousForceCli")==null);
  Marker(b,Executable(a)); Set("PreviousCodexCliPath",Executable(a));
  try { Call("FlattenLegacyPrevious"); throw new Exception("cycle-allowed"); } catch(InvalidOperationException) { Check((string)Get("PreviousCodexCliPath")==Executable(a)); }
  Marker(b,null,null,"S-1-5-18");
  try { Call("FlattenLegacyPrevious"); throw new Exception("foreign-owner-allowed"); } catch(InvalidOperationException) { Check((string)Get("PreviousCodexCliPath")==Executable(a)); }
  string tree=Path.Combine(cache,new string('c',64)); Marker(tree,null);
  var files=new SortedDictionary<string,string>(StringComparer.Ordinal);
  foreach(string relative in new[]{"Rele.Codex.exe","runtime\\node.exe","dist\\native\\Rele.Process.exe","package.json","dist\\server\\main.js"}) {
   string file=Path.Combine(tree,relative); Directory.CreateDirectory(Path.GetDirectoryName(file)); File.WriteAllText(file,"synthetic code: "+relative); files.Add(relative,file);
  }
  var identity=new StringBuilder(File.ReadAllText(Path.Combine(tree,"rele-install.json")));
  using(var sha=SHA256.Create()) foreach(var f in files) using(var input=File.OpenRead(f.Value)) identity.Append('\n').Append(f.Key).Append(':').Append(BitConverter.ToString(sha.ComputeHash(input)));
  string expected=(string)Call("TextHash",identity.ToString()); object snapshot=Call("AdapterSnapshot",tree);
  Check((string)snapshot.GetType().GetField("Fingerprint").GetValue(snapshot)==expected);
  string renamed=Path.Combine(cache,".cleanup-"+expected+"-"+Guid.NewGuid().ToString("N")); Directory.Move(tree,renamed);
  snapshot=Call("AdapterSnapshot",renamed); Check((string)snapshot.GetType().GetField("Fingerprint").GetValue(snapshot)==expected);
  File.WriteAllText(Path.Combine(renamed,"personal-document.txt"),"must keep");
  try { Call("AdapterSnapshot",renamed); throw new Exception("unknown-file-allowed"); } catch(InvalidOperationException) { passed++; }
  Console.WriteLine(json.Serialize(new {passed=passed,taskActions=0,environmentChanges=0,nativeProcesses=0}));
 }
}
`);
  const executable = path.join(temporary, 'Smoke.exe');
  run(compiler, ['/nologo', '/target:exe', '/platform:x64', '/codepage:65001', '/r:System.Web.Extensions.dll', `/out:${executable}`, source]);
  const receipt = JSON.parse(run(executable, [library, temporary]));
  assert.equal(receipt.passed, 27);
  console.log(JSON.stringify(receipt));
} finally { await rm(temporary, { recursive: true, force: true }); }
