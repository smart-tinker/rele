import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, mkdir, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertSteps, writeBundle, verifyBundles } from '../scripts/ci-contract.mjs';
import { summarizeSharedNativeRequest } from '../scripts/shared-probe-diagnostics.mjs';
const sha = 'a'.repeat(40), run = '123', attempt = '1', version = '0.1.2-rc.1';
const candidate={repository:'owner/repo',version,commit:sha,runId:run,attempt};
async function releaseBackend(root) {
 const {prepareCandidate,uploadPlatform}=await import('../scripts/ci-publish.mjs');
 const state={main:sha,tag:null,release:null,assets:[],bodies:new Map(),calls:[]};
 const api=async(route,options={})=>{
  state.calls.push({route,...options});
  if(options.upload) {
   const name=new URL('https://uploads.github.com'+route).searchParams.get('name');
   assert.ok(!state.assets.some(asset=>asset.name===name),'Duplicate asset upload');
   const asset={id:state.assets.length+101,name,size:options.body.length,digest:'sha256:'+createHash('sha256').update(options.body).digest('hex')};
   state.assets.push(asset);state.bodies.set(asset.id,Buffer.from(options.body));return {...asset};
  }
  if(options.method==='POST') {
   assert.ok(!state.release,'Cannot replace an existing draft');
   state.release={id:77,html_url:'https://github.com/owner/repo/releases/77',...options.body};return {...state.release};
  }
  if(options.method==='PATCH') {state.release={...state.release,...options.body};return {...state.release};}
  assert.ok(!options.method || options.method==='GET','Deletion is forbidden');
  if(route.endsWith('/git/ref/heads/main'))return {object:{sha:state.main}};
  if(route.includes('/git/ref/tags/'))return state.tag;
  if(route.includes('/releases?'))return state.release?[{...state.release}]:[];
  if(route.endsWith('/releases/77'))return state.release?{...state.release}:null;
  if(route.endsWith('/releases/77/assets?per_page=100'))return state.assets.map(asset=>({...asset}));
  if(options.download)return state.bodies.get(Number(route.split('/').at(-1)));
  throw new Error('Unexpected API read '+route);
 };
 const prepared=async()=>prepareCandidate(api,candidate);
 const uploaded=async()=>{await prepared();await Promise.all(['linux','windows'].map(platform=>uploadPlatform(api,candidate,77,path.join(root,platform),platform)));};
 return {state,api,prepared,uploaded};
}
test('missing, skipped and failed required steps cannot pass', () => {
 assert.doesNotThrow(() => assertSteps({a:{outcome:'success',conclusion:'success'}}, ['a']));
 for (const outcome of ['skipped','failure','cancelled']) assert.throws(() => assertSteps({a:{outcome,conclusion:'success'}}, ['a']));
 assert.throws(() => assertSteps({}, ['a']));
});
test('required-step failures report every failed outcome', () => {
 assert.throws(() => assertSteps({
  standard_user:{outcome:'failure',conclusion:'failure'},
  browser_install:{outcome:'skipped',conclusion:'skipped'},
 }, ['browser_install','standard_user']), /Required steps did not pass: browser_install=skipped, standard_user=failure/u);
});
async function fixture(fn) {
 const root=await mkdtemp(path.join(tmpdir(),'rele-ci-'));
 try {
  for(const platform of ['linux','windows']) {
   const release=path.join(root,platform);await mkdir(release);
   const stem=`rele-${version}-${platform}-x64`;
   const exts=platform==='linux'?['.deb','.tar.gz']:['-setup.exe','.zip'];
   for(const ext of exts){const name=stem+ext;const data=Buffer.from(name);await writeFile(path.join(release,name),data);await writeFile(path.join(release,name+'.sha256'),createHash('sha256').update(data).digest('hex')+'  '+name+'\n');}
   await writeBundle(release,platform,version,sha,run,attempt);
  }
  await fn(root);
 } finally {await rm(root,{recursive:true,force:true});}
}
test('publisher accepts only both exact platform bundles from this run',()=>fixture(async root=>{
 const result=await verifyBundles(root,version,sha,run,attempt);assert.equal(result.files.length,8);
 await assert.rejects(verifyBundles(root,version,sha,run,'2'));
 await rm(path.join(root,'windows'),{recursive:true});await assert.rejects(verifyBundles(root,version,sha,run,attempt));
}));
test('tampering, unexpected files, and symlinks fail before publication',()=>fixture(async root=>{
 const file=path.join(root,'linux',`rele-${version}-linux-x64.deb`);
 await writeFile(file,'tampered');await assert.rejects(verifyBundles(root,version,sha,run,attempt));
}));
test('native request diagnostics expose state without IDs or response text',()=>{
 const summary=summarizeSharedNativeRequest({state:'completed',turnId:'synthetic-turn-id',text:'synthetic response body'});
 assert.deepEqual(summary,{state:'completed',turnAssigned:true,queuedSubmissionFound:false,mixed:false,finalAnswerPresent:true});
 assert.doesNotMatch(JSON.stringify(summary),/synthetic-turn-id|synthetic response body/u);
 assert.equal(summarizeSharedNativeRequest({state:'running',queuedSubmissionId:'synthetic-queue-id',text:'NOREPLY'}).state,'running');
 assert.equal(summarizeSharedNativeRequest({state:'running',queuedSubmissionId:'synthetic-queue-id',text:'NOREPLY'}).queuedSubmissionFound,true);
 assert.equal(summarizeSharedNativeRequest({state:'running',queuedSubmissionId:'synthetic-queue-id',text:'NOREPLY'}).finalAnswerPresent,false);
 assert.equal(summarizeSharedNativeRequest({state:'unexpected',failureReason:'private detail'}).state,'unknown');
});
test('unlisted file is rejected',()=>fixture(async root=>{
 await writeFile(path.join(root,'linux','extra'),'extra');await assert.rejects(verifyBundles(root,version,sha,run,attempt));
}));
test('symlink cannot substitute a package',()=>fixture(async root=>{
 const file=path.join(root,'linux',`rele-${version}-linux-x64.deb`);await rm(file);
 await symlink(path.join(root,'windows'),file,process.platform==='win32'?'junction':undefined);
 await assert.rejects(verifyBundles(root,version,sha,run,attempt));
}));
test('preparation refuses advanced main, occupied tags and existing drafts before any write',()=>fixture(async root=>{
 for(const mutation of ['main','tag','release']) {
  const f=await releaseBackend(root);
  if(mutation==='main')f.state.main='b'.repeat(40);
  if(mutation==='tag')f.state.tag={object:{type:'commit',sha}};
  if(mutation==='release')f.state.release={tag_name:`v${version}`,draft:true};
  await assert.rejects(f.prepared());assert.ok(f.state.calls.every(call=>!call.method));
 }
}));
test('publisher finalizes a prepared draft without replacing packages or deleting transfers',()=>fixture(async root=>{
 const {downloadCandidate,publishCandidate}=await import('../scripts/ci-publish.mjs');
 const f=await releaseBackend(root);await f.uploaded();
 const incoming=path.join(root,'incoming');await downloadCandidate(f.api,candidate,77,incoming);
 for(const platform of ['linux','windows']) {
  const metadata=f.state.assets.find(asset=>asset.name===`${platform}-evidence.json`);
  assert.deepEqual(await readFile(path.join(incoming,platform,'evidence.json')),f.state.bodies.get(metadata.id),'Remote evidence renaming must preserve the attested bytes');
 }
 const before=f.state.calls.length;
 const result=await publishCandidate(f.api,await verifyBundles(incoming,version,sha,run,attempt),candidate,77);
 assert.equal(result.id,77);assert.equal(result.draft,true);assert.equal(result.prerelease,true);
 assert.match(result.body,/Verification passed/u);
 const writes=f.state.calls.slice(before).filter(call=>call.method);
 assert.deepEqual(writes.map(item=>[item.method,item.upload?new URL('https://uploads.github.com'+item.route).searchParams.get('name'):item.route]),[
  ['POST','verification.json'],['PATCH','/repos/owner/repo/releases/77'],
 ]);
 assert.equal(f.state.assets.length,11);assert.equal(f.state.calls.filter(call=>call.upload).length,11);
 assert.ok(f.state.calls.every(call=>call.method!=='DELETE' && !call.route.includes('/actions/')));
}));
test('draft identity and source/run/attempt changes stop uploads before any asset write',()=>fixture(async root=>{
 const {uploadPlatform}=await import('../scripts/ci-publish.mjs');
 for(const patch of [{id:78},{draft:false},{prerelease:false},{target_commitish:'b'.repeat(40)},{tag_name:'v0.1.2-rc.99'},
  {body:`Rele candidate ${sha}; run 999; attempt ${attempt}. Verification pending.`},
  {body:`Rele candidate ${sha}; run ${run}; attempt 2. Verification pending.`}]) {
  const f=await releaseBackend(root);await f.prepared();Object.assign(f.state.release,patch);
  await assert.rejects(uploadPlatform(f.api,candidate,77,path.join(root,'linux'),'linux'));assert.equal(f.state.assets.length,0);
 }
}));
test('lost preparation ACK leaves its draft without a second creation attempt',()=>fixture(async root=>{
 const {prepareCandidate}=await import('../scripts/ci-publish.mjs');const f=await releaseBackend(root);
 const api=async(route,options={})=>{const result=await f.api(route,options);if(options.method==='POST')throw new Error('ACK lost');return result;};
 await assert.rejects(prepareCandidate(api,candidate),/ACK lost/u);
 assert.ok(f.state.release);await assert.rejects(prepareCandidate(api,candidate),/Release already exists/u);
 assert.equal(f.state.calls.filter(call=>call.method==='POST').length,1);
}));
test('partial or uncertain platform upload stays in its draft and cannot be replayed',()=>fixture(async root=>{
 const {uploadPlatform}=await import('../scripts/ci-publish.mjs');
 for(const failure of ['lost ACK','wrong digest']) {
  const f=await releaseBackend(root);await f.prepared();let uploaded=0;
  const api=async(route,options={})=>{const result=await f.api(route,options);if(options.upload && ++uploaded===2){if(failure==='lost ACK')throw new Error('ACK lost');return {...result,digest:'sha256:'+'0'.repeat(64)};}return result;};
  await assert.rejects(uploadPlatform(api,candidate,77,path.join(root,'linux'),'linux'));
  assert.equal(f.state.assets.length,2);assert.equal(f.state.release.draft,true);assert.match(f.state.release.body,/pending/u);
  const writes=f.state.calls.filter(call=>call.method).length;
  await assert.rejects(uploadPlatform(api,candidate,77,path.join(root,'linux'),'linux'),/reconcile before retry/u);
  assert.equal(f.state.calls.filter(call=>call.method).length,writes);assert.ok(f.state.calls.every(call=>call.method!=='DELETE'));
 }
}));
test('platform upload revalidates its draft and main after every upload ACK',()=>fixture(async root=>{
 const {uploadPlatform}=await import('../scripts/ci-publish.mjs');
 for(const changedAfter of [1,5])for(const mutation of ['draft published','main advanced','run/attempt changed']) {
  const f=await releaseBackend(root);await f.prepared();let uploads=0;
  const api=async(route,options={})=>{
   const result=await f.api(route,options);
   if(options.upload && ++uploads===changedAfter) {
    if(mutation==='draft published')f.state.release.draft=false;
    else if(mutation==='main advanced')f.state.main='b'.repeat(40);
    else f.state.release.body=`Rele candidate ${sha}; run 999; attempt 2. Verification pending.`;
   }
   return result;
  };
  await assert.rejects(uploadPlatform(api,candidate,77,path.join(root,'linux'),'linux'),undefined,`${mutation} after ACK ${changedAfter}`);
  assert.equal(uploads,changedAfter,'No upload may follow a changed target');
  assert.equal(f.state.assets.length,changedAfter);
  assert.equal(f.state.calls.filter(call=>call.method==='PATCH' || call.method==='DELETE').length,0);
 }
}));
test('download rejects missing, extra and tampered draft assets',()=>fixture(async root=>{
 const {downloadCandidate}=await import('../scripts/ci-publish.mjs');
 for(const failure of ['missing','extra','tampered']) {
  const f=await releaseBackend(root);await f.uploaded();
  if(failure==='missing')f.state.assets.pop();
  if(failure==='extra')f.state.assets.push({...f.state.assets[0],id:999,name:'unexpected.exe'});
  if(failure==='tampered')f.state.bodies.set(f.state.assets[0].id,Buffer.from('changed after upload'));
  await assert.rejects(downloadCandidate(f.api,candidate,77,path.join(root,failure)));
  assert.equal(f.state.release.draft,true);assert.match(f.state.release.body,/pending/u);
 }
}));
test('finalizer refuses wrong assets, hashes or build identity before any final write',()=>fixture(async root=>{
 const {publishCandidate}=await import('../scripts/ci-publish.mjs');const bundle=await verifyBundles(root,version,sha,run,attempt);
 for(const failure of ['missing','extra','hash','main','run','attempt']) {
  const f=await releaseBackend(root);await f.uploaded();
  if(failure==='missing')f.state.assets.pop();
  if(failure==='extra')f.state.assets.push({...f.state.assets[0],id:999,name:'unexpected.exe'});
  if(failure==='hash')f.state.assets[0].digest='sha256:'+'0'.repeat(64);
  if(failure==='main')f.state.main='b'.repeat(40);
  const changed=failure==='run'?{...candidate,runId:'999'}:failure==='attempt'?{...candidate,attempt:'2'}:candidate;
  const writes=f.state.calls.filter(call=>call.method).length;
  await assert.rejects(publishCandidate(f.api,bundle,changed,77));
  assert.equal(f.state.calls.filter(call=>call.method).length,writes);
 }
}));
test('uncertain final upload and advanced main leave an unverified draft without replay',()=>fixture(async root=>{
 const {publishCandidate}=await import('../scripts/ci-publish.mjs');const bundle=await verifyBundles(root,version,sha,run,attempt);
 for(const failure of ['lost ACK','main advanced','draft published']) {
  const f=await releaseBackend(root);await f.uploaded();
  const api=async(route,options={})=>{const result=await f.api(route,options);if(options.upload){if(failure==='lost ACK')throw new Error('ACK lost');if(failure==='draft published')f.state.release.draft=false;else f.state.main='b'.repeat(40);}return result;};
  await assert.rejects(publishCandidate(api,bundle,candidate,77));
  assert.equal(f.state.assets.length,11);assert.equal(f.state.release.draft,failure!=='draft published');assert.match(f.state.release.body,/pending/u);
  assert.equal(f.state.calls.filter(call=>call.method==='PATCH').length,0);
  const uploads=f.state.calls.filter(call=>call.upload).length;
  await assert.rejects(publishCandidate(api,bundle,candidate,77));assert.equal(f.state.calls.filter(call=>call.upload).length,uploads);
 }
}));
test('workflow requirement lists tolerate empty conditional groups', async()=>{
 const {spawnSync}=await import('node:child_process');
 for(const required of ['install unit   ','install unit linux ','install unit  windows']) {
  const steps=Object.fromEntries(required.trim().split(/\s+/u).map(id=>[id,{outcome:'success',conclusion:'success'}]));
  const result=spawnSync(process.execPath,['scripts/ci.mjs','steps'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,STEPS:JSON.stringify(steps),REQUIRED:required},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
 }
});
test('shared wait timeout reports bounded request correlation without message bodies', async()=>{
 let summarize;
 try { ({summarizeSharedWaitFailure:summarize}=await import('../scripts/shared-probe-diagnostics.mjs')); }
 catch(error) { if(error?.code==='ERR_MODULE_NOT_FOUND') assert.fail('shared timeout diagnostics must be available'); throw error; }
 assert.deepEqual(summarize('waiting_approval',{
  requests:[{id:'request-1',eventId:'approval',status:'uncertain',turnId:'turn-1',queuedSubmissionId:'queue-1',text:'private message'}],
  approvals:[{id:'approval-1',requestId:'request-1',method:'item/commandExecution/requestApproval',status:'pending',turnId:'turn-1',details:'private approval'}],
  observedTurns:[{method:'turn/started',threadId:'thread-1',turnId:'turn-1'}],
  observedProtocolEvents:[
   {kind:'request',method:'item/commandExecution/requestApproval',hasThreadId:true,hasTurnId:true,hasRequestId:true,hasItemId:true,hasApprovalId:false,id:'private-rpc-id',command:'private command'},
   {kind:'notification',method:'serverRequest/resolved',hasThreadId:true,hasTurnId:false,hasRequestId:true,hasItemId:false,hasApprovalId:false,requestId:'private-request-id'},
   {kind:'request',method:'private user text',hasThreadId:true,hasTurnId:true,hasRequestId:true,hasItemId:false,hasApprovalId:false},
  ],
  driverOperations:Array.from({length:50},(_,index)=>`operation-${index}`),
  completionObservations:[{eventId:'after-shell-cancel',status:'running',turnMatches:true,turnId:'private-turn-id'}],
  reconciliationTrace:[{eventId:'after-shell-cancel',phase:'error',status:'uncertain',completionNotification:true,turnProvided:true,elapsedMs:123,errorType:'CodexTransportError',message:'private'}],
  rpcTrace:[{attempt:3,method:'thread/items/list',phase:'error',elapsedMs:123,errorType:'CodexTransportError',params:'private'}],
  serverRequestTrace:[{method:'item/commandExecution/requestApproval',pendingAtEntry:true,activeRequests:2,threadMatches:1,exactMatches:1,
   historyState:'running',historyTurnMatches:true,pendingAtExit:true,statusAfter:'waiting_approval',approvalsAdded:1,errorType:'private error'}],
  reconciliationStageTrace:[{operation:'subscribe',phase:'done',elapsedMs:9},
   {operation:'findCompletionHistory',phase:'start'},
   {operation:'findOwnRequest',phase:'error',elapsedMs:30000,errorType:'CodexTransportError',message:'private'}],
 }),{
  expectedStatus:'waiting_approval',
  requests:[{id:'request-1',eventId:'approval',status:'uncertain',turnId:'turn-1',queuedSubmissionId:'queue-1'}],
  approvals:[{id:'approval-1',requestId:'request-1',method:'item/commandExecution/requestApproval',status:'pending',turnId:'turn-1'}],
  observedTurns:[{method:'turn/started',turnId:'turn-1'}],
  protocolEvents:[
   {kind:'request',method:'item/commandExecution/requestApproval',hasThreadId:true,hasTurnId:true,hasRequestId:true,hasItemId:true,hasApprovalId:false},
   {kind:'notification',method:'serverRequest/resolved',hasThreadId:true,hasTurnId:false,hasRequestId:true,hasItemId:false,hasApprovalId:false},
   {kind:'request',method:'other',hasThreadId:true,hasTurnId:true,hasRequestId:true,hasItemId:false,hasApprovalId:false},
  ],
  completionObservations:[{eventId:'after-shell-cancel',status:'running',turnMatches:true}],
  reconciliationTrace:[{eventId:'after-shell-cancel',phase:'error',status:'uncertain',completionNotification:true,turnProvided:true,elapsedMs:123,errorType:'CodexTransportError'}],
  rpcTrace:[{attempt:3,method:'thread/items/list',phase:'error',elapsedMs:123,errorType:'CodexTransportError'}],
  serverRequestTrace:[{method:'item/commandExecution/requestApproval',pendingAtEntry:true,activeRequests:2,threadMatches:1,exactMatches:1,
   historyState:'running',historyTurnMatches:true,pendingAtExit:true,statusAfter:'waiting_approval',approvalsAdded:1}],
  reconciliationStageTrace:[{operation:'subscribe',phase:'done',elapsedMs:9},
   {operation:'findCompletionHistory',phase:'start'},
   {operation:'findOwnRequest',phase:'error',elapsedMs:30000,errorType:'CodexTransportError'}],
  driverOperations:Array.from({length:40},(_,index)=>`operation-${index+10}`),
 });
 assert.doesNotMatch(JSON.stringify(summarize('waiting_approval',{
  requests:[],approvals:[],observedTurns:[],driverOperations:[],observedProtocolEvents:[
   {kind:'request',method:'item/commandExecution/requestApproval',hasThreadId:true,hasTurnId:true,hasRequestId:true,id:'private-rpc-id',command:'private command'}
  ]
 })),/private-rpc-id|private command/u);
});
test('the aggregate gate accepts only the selected successful verification and skipped alternative', async()=>{
 const workflow=await readFile(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
 const start=workflow.indexOf('\n  gate:\n');
 const end=workflow.indexOf('\n  publish:\n',start);
 const gate=workflow.slice(start,end);
 const command=gate.match(/^\s+run: (.+)$/mu)?.[1];
 assert.ok(command,'aggregate gate must have a one-line shell command');
 const expectation=gate.match(/EXPECTED_RESULTS: \$\{\{ (.+) \}\}/u)?.[1];
 assert.ok(expectation,'select the expected job results from the release input');
 const expectedResults=new Function('inputs',`return (${expectation});`);
 const {spawnSync}=await import('node:child_process');
 for(const release of [false,true]) for(const verifyResult of ['success','failure','cancelled','skipped']) for(const releaseResult of ['success','failure','cancelled','skipped']) {
  const expected=release?'skipped:success':'success:skipped';
  assert.equal(expectedResults({release}),expected);
  const status=`${verifyResult}:${releaseResult}`===expected?0:1;
  const result=spawnSync('bash',['-e','-o','pipefail','-c',command],{
   env:{...process.env,VERIFY_RESULT:verifyResult,RELEASE_RESULT:releaseResult,EXPECTED_RESULTS:expected},encoding:'utf8',
  });
  assert.ifError(result.error);
  assert.equal(result.status,status,`release=${release}, verify=${verifyResult}, release_verify=${releaseResult}`);
 }
});
test('ordinary events cannot select the write-scoped reusable build job', async()=>{
 const workflow=await readFile(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
 const start=workflow.indexOf('\n  verify:\n'),releaseStart=workflow.indexOf('\n  verify_release:\n'),end=workflow.indexOf('\n  gate:\n');
 assert.ok(start>=0 && releaseStart>start && end>releaseStart,'separate ordinary verification from release verification');
 const jobs=[workflow.slice(start,releaseStart),workflow.slice(releaseStart,end)];
 const select=jobs.map(job=>new Function('github','inputs',`return (${job.match(/^    if: (.+)$/mu)?.[1]});`));
 const build=await readFile(new URL('../.github/workflows/verify.yml',import.meta.url),'utf8');
 const buildAllowed=new Function('github','inputs',`return (${build.match(/^    if: (.+)$/mu)?.[1]});`);
 const releaseConditions=['Bind packages to this verified commit and run','Attest the exact verified build bytes','Upload verified packages directly to the prepared draft'].map(name=>{
  const start=build.indexOf(`name: ${name}\n`),end=build.indexOf('\n      - ',start+1);
  const step=build.slice(start,end<0?undefined:end);
  const condition=step.match(/^        if: (.+)$/mu)?.[1];
  assert.ok(condition,`${name} must be conditional`);
  return new Function('github','inputs',`return (${condition});`);
 });
 for(const [event,release,ref,isPrivate,want] of [
  ['pull_request',false,'refs/pull/1/merge',false,[true,false]],
  ['push',false,'refs/heads/main',false,[true,false]],
  ['workflow_dispatch',false,'refs/heads/main',false,[true,false]],
  ['workflow_dispatch',false,'refs/heads/topic',false,[true,false]],
  ['workflow_dispatch',true,'refs/heads/main',false,[false,true]],
  ['workflow_dispatch',true,'refs/heads/topic',false,[false,false]],
  ['workflow_dispatch',true,'refs/heads/main',true,[false,false]],
  ['pull_request',false,'refs/pull/1/merge',true,[false,false]],
  ['push',true,'refs/heads/main',false,[false,false]],
 ]) {
  const github={event_name:event,ref,event:{repository:{private:isPrivate}}};
  assert.deepEqual(select.map(condition=>Boolean(condition(github,{release}))),want,`${event}, release=${release}, ref=${ref}, private=${isPrivate}`);
  for(const condition of releaseConditions) assert.equal(Boolean(buildAllowed(github,{release}) && condition(github,{release})),want[1],`release side effect on ${event}, release=${release}, ref=${ref}, private=${isPrivate}`);
 }
 const preparation=workflow.slice(workflow.indexOf('\n  prepare_release:\n'),workflow.indexOf('\n  verify:\n'));
 const prepare=new Function('github','inputs',`return (${preparation.match(/^    if: (.+)$/mu)?.[1]});`);
 for(const event of ['pull_request','push','workflow_dispatch']) for(const release of [false,true]) for(const ref of ['refs/heads/main','refs/heads/topic']) for(const isPrivate of [false,true]) {
  const github={event_name:event,ref,event:{repository:{private:isPrivate}}};
  assert.equal(Boolean(prepare(github,{release})),event==='workflow_dispatch' && release && ref==='refs/heads/main' && !isPrivate);
 }
 const permissions=job=>Object.fromEntries(job.match(/^    permissions:\n((?:      [\w-]+: \w+\n)+)/mu)[1].trim().split('\n').map(line=>line.trim().split(': ')));
 assert.deepEqual(permissions(jobs[0]),{contents:'read',actions:'read'});
 assert.deepEqual(permissions(jobs[1]),{contents:'write',actions:'read','id-token':'write',attestations:'write'});
 for(const job of jobs) assert.match(job,/uses: \.\/\.github\/workflows\/verify\.yml/u,'run one shared original build job');
 assert.match(jobs[0],/release: false/u);assert.match(jobs[1],/release: true/u);
});
test('publisher verifies every incoming file against the reusable build identity and stops on rejection', async()=>{
 const workflow=await readFile(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
 const publisher=workflow.slice(workflow.indexOf('\n  publish:\n'));
 const command=publisher.match(/name: Verify draft build attestations[\s\S]*?        run: \|\n([\s\S]*?)(?=\n      - name:)/u)?.[1];
 assert.ok(command,'verify attestations before the publisher finalizes a draft');
 const root=await mkdtemp(path.join(tmpdir(),'rele-attest-'));
 try {
  await mkdir(path.join(root,'bin'));
  await writeFile(path.join(root,'bin','gh'),'#!/bin/sh\nprintf \'%s\\n\' "$*" >> calls.txt\nexit "$ATTESTATION_STATUS"\n',{mode:0o755});
  const files=['incoming/linux/evidence.json','incoming/linux/package.deb','incoming/windows/evidence.json','incoming/windows/package.zip'];
  for(const file of files) {await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),'verified bytes');}
  const {spawnSync}=await import('node:child_process');
  const env={...process.env,PATH:path.join(root,'bin')+path.delimiter+process.env.PATH,GITHUB_REPOSITORY:'owner/repo',GITHUB_SHA:sha};
  for(const status of [0,1]) {
   await rm(path.join(root,'calls.txt'),{force:true});
   const result=spawnSync('bash',['-e','-o','pipefail','-c',command],{cwd:root,env:{...env,ATTESTATION_STATUS:String(status)},encoding:'utf8'});
   assert.ifError(result.error);assert.equal(result.status,status,result.stderr);
   const calls=(await readFile(path.join(root,'calls.txt'),'utf8')).trim().split('\n');
   assert.deepEqual(calls,(status===0?files:files.slice(0,1)).map(file=>
    `attestation verify ${file} --repo owner/repo --signer-workflow owner/repo/.github/workflows/verify.yml --source-digest ${sha} --source-ref refs/heads/main --deny-self-hosted-runners`));
  }
 } finally {await rm(root,{recursive:true,force:true});}
});
test('one required CI gate waits for every OS matrix job', async()=>{
 const workflow=await readFile(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
 const start=workflow.indexOf('\n  gate:\n');
 assert.notEqual(start,-1,'missing aggregate gate job');
 const end=workflow.indexOf('\n  publish:\n',start);
 assert.notEqual(end,-1,'gate must precede the publisher');
 const gate=workflow.slice(start,end);
 assert.match(gate,/name: CI gate/u);
 assert.match(gate,/needs: \[verify, verify_release\]/u);
 assert.match(gate,/always\(\)/u);
 assert.match(gate,/github\.event\.repository\.private == false/u);
 assert.match(gate,/needs\.verify\.result/u);
 assert.match(gate,/needs\.verify_release\.result/u);
 const publisher=workflow.slice(workflow.indexOf('\n  publish:\n'));
 assert.match(publisher,/needs: \[prepare_release, verify_release, gate\]/u);
 const condition=publisher.match(/^    if: \$\{\{ (.+) \}\}$/mu)?.[1];
 assert.ok(condition,'explicitly guard publication after the unselected job skips');
 const publish=new Function('github','inputs','needs','cancelled',`return (${condition});`);
 const github={event_name:'workflow_dispatch',ref:'refs/heads/main',event:{repository:{private:false}}};
 for(const releaseResult of ['success','failure','cancelled','skipped']) for(const gateResult of ['success','failure','cancelled','skipped']) for(const cancelled of [false,true]) {
  assert.equal(publish(github,{release:true},{verify_release:{result:releaseResult},gate:{result:gateResult}},()=>cancelled),
   !cancelled && releaseResult==='success' && gateResult==='success');
 }
 for(const event of ['pull_request','push','workflow_dispatch']) for(const release of [false,true]) for(const ref of ['refs/heads/main','refs/heads/topic']) for(const isPrivate of [false,true]) {
  const context={event_name:event,ref,event:{repository:{private:isPrivate}}};
  assert.equal(publish(context,{release},{verify_release:{result:'success'},gate:{result:'success'}},()=>false),
   !isPrivate && event==='workflow_dispatch' && release && ref==='refs/heads/main');
 }
});
test('Windows job timeout leaves room for its bounded standard-user native gate', async()=>{
 const workflow=await readFile(new URL('../.github/workflows/verify.yml',import.meta.url),'utf8');
 const canary=await readFile(new URL('../scripts/windows/ci-standard-user-canary.ps1',import.meta.url),'utf8');
 const verify=workflow.slice(workflow.indexOf('\n  verify:\n'));
 const jobTimeout=verify.match(/^\s+timeout-minutes:\s*\$\{\{\s*matrix\.os\s*==\s*'windows-2025'\s*&&\s*(\d+)\s*\|\|\s*(\d+)\s*\}\}\s*$/mu);
 const gateTimeout=canary.match(/AddMinutes\(\$\(if \(\$Phase -eq 'Shared'\) \{ (\d+) \} else \{ (\d+) \}\)\)/u);
 assert.ok(jobTimeout,'give Windows its own timeout without extending Ubuntu');
 assert.ok(gateTimeout,'read the native gate deadline from the canary');
 assert.ok(Number(gateTimeout[2])>=145,'leave time for the observed shared suite and the installer lifecycle that exceeded the old deadline');
 assert.ok(Number(jobTimeout[1])>=Number(gateTimeout[2])+45,'leave time for runner setup, later checks, and cleanup');
 assert.equal(Number(jobTimeout[2]),60,'keep the Ubuntu timeout unchanged');
});
test('shared protocol completion wait fits within its driver response budget', async()=>{
 const probe=await readFile(new URL('../scripts/probe-shared-codex.ts',import.meta.url),'utf8');
 const harness=await readFile(new URL('../scripts/shared-protocol-probe.py',import.meta.url),'utf8');
 assert.ok(/const ENGINE_WAIT_TIMEOUT_MS = 90_000/u.test(probe),'allow cold shared Desktop completion to settle');
 assert.ok(/const until = Date\.now\(\) \+ ENGINE_WAIT_TIMEOUT_MS/u.test(probe));
 assert.ok(/ENGINE_WAIT_READ_TIMEOUT_SECONDS = 120/u.test(harness),'keep the harness listening beyond its turn wait');
 assert.ok(/timeout = ENGINE_CANCEL_READ_TIMEOUT_SECONDS if action == 'cancel' else ENGINE_WAIT_READ_TIMEOUT_SECONDS if action == 'wait' else ENGINE_READ_TIMEOUT_SECONDS/u.test(harness));
});
test('Windows canary timeout reports only bounded installer progress', async()=>{
 const canary=await readFile(new URL('../scripts/windows/ci-standard-user-canary.ps1',import.meta.url),'utf8');
 const installer=await readFile(new URL('../scripts/smoke-windows-installer.mjs',import.meta.url),'utf8');
 const start=canary.indexOf('$summary = [ordered]@{ stage =');
 const end=canary.indexOf("Write-Output ('Windows canary bounded diagnostic:",start);
 assert.ok(start>=0 && end>start,'Windows canary must emit a bounded timeout summary');
 assert.match(canary,/WaitForExit\(\[Math\]::Min\(\$remaining, 30000\)\)/u,'poll the bounded fixture process so active progress can be reported');
 assert.ok(/Write-Host \('Windows canary progress: '/u.test(canary),'send progress outside the captured Boolean return value');
 assert.match(canary,/RELE_CI_STAGE=\[a-z0-9.-\]\{1,96\}/u,'accept only fixed-format stage labels from the fixture log');
 assert.match(installer,/RELE_CI_STAGE=installer-reinstall/u,'identify the installer re-adoption phase');
 const summary=canary.slice(start,end);
 assert.ok(/Get-Content -LiteralPath \$stdout -Tail 64(?: -ErrorAction SilentlyContinue)?\s*\|\s*Where-Object \{ \$_ -cmatch/u.test(canary),
  'retain only bounded installer stage labels');
 assert.match(summary,/\$summary\.installerProgress = @\(\$result\.installerProgress \| Select-Object -Last 8\)/u,
  'include the latest bounded installer progress labels in the timeout summary');
 assert.doesNotMatch(summary,/stdout\.log|stderr\.log/u,'never print raw installer logs');
});
test('Windows canary timeout reports bounded native RPC and driver stages', async()=>{
 const harness=await readFile(new URL('../scripts/shared-protocol-probe.py',import.meta.url),'utf8');
 const canary=await readFile(new URL('../scripts/windows/ci-standard-user-canary.ps1',import.meta.url),'utf8');
 const evidenceStart=harness.indexOf('    async def held_request_evidence(');
 const evidenceEnd=harness.indexOf('\n    async def wait_records',evidenceStart);
 const summaryStart=canary.indexOf('$summary = [ordered]@{ stage =');
 const summaryEnd=canary.indexOf("Write-Output ('Windows canary bounded diagnostic:",summaryStart);
 assert.ok(evidenceStart>=0&&evidenceEnd>evidenceStart&&summaryStart>=0&&summaryEnd>summaryStart,'Windows timeout path must collect and emit bounded diagnostics');
 const evidence=harness.slice(evidenceStart,evidenceEnd),summary=canary.slice(summaryStart,summaryEnd);
 assert.match(evidence,/evidence\['rpcTrace'\] = engine_snapshot\.get\('rpcTrace', \[\]\)\[-16:\]/u,'capture the latest native RPC stages');
 assert.match(summary,/\$summary\.rpcTrace = @\(\$evidence\.rpcTrace \| Select-Object -Last 16\)/u,'print only the latest bounded RPC trace');
 assert.match(summary,/\$summary\.driverOperations = @\(\$evidence\.driverOperations \| Select-Object -Last 16\)/u,'print only the latest bounded driver operation stages');
 assert.doesNotMatch(summary,/payload|\.input\b|\.text\b|stdout\.log|stderr\.log/u,'timeout diagnostics must exclude request content and raw logs');
});
test('shared fixture cleanup identifies the timed out operation without raw error text', async()=>{
 const probe=await readFile(new URL('../scripts/shared-protocol-probe.py',import.meta.url),'utf8');
 const start=probe.indexOf('cleanup_errors = []',probe.indexOf('async def scenario(order):'));
 const end=probe.indexOf('\n\n    try:\n        if args.desktop_bundle:',start);
 assert.ok(start>=0 && end>start,'capture cleanup failures in the isolated scenario');
 const cleanup=probe.slice(start,end);
 assert.match(cleanup,/\('engine\.close', engine\).*\('observer\.close', observer\).*\('peer\.close', peer\)/su,
  'label each independently closed fixture client');
 assert.match(cleanup,/'operation':/u,'record the failing operation');
 assert.match(cleanup,/'elapsedMs':/u,'record bounded monotonic elapsed time');
 assert.match(cleanup,/'errorType':/u,'record only the exception category');
 assert.match(cleanup,/'resource':/u,'identify the owned resource');
 assert.match(cleanup,/'native\.stop'/u,'distinguish native stop from client close');
 assert.match(cleanup,/'ownerPid':/u,'include the observed native owner PID when known');
 assert.doesNotMatch(cleanup,/repr\(error\)|str\(error\)/u,'do not print raw exception details');
 assert.match(cleanup,/if primary_error is None:/u,'keep cleanup diagnostics separate from the primary failure');
 assert.match(probe,/console_report = dict\(report\)[\s\S]*console_report\['retainedFixture'\] = 'retained'[\s\S]*print\(json\.dumps\(console_report,/u,
  'redact the retained fixture path from public runner output');
});
test('browser setup installs the pinned Playwright browser without apt dependencies', async()=>{
 const workflow=await readFile(new URL('../.github/workflows/verify.yml',import.meta.url),'utf8');
 assert.ok(workflow.includes('- run: npx playwright install chromium\n        id: browser_install'));
 assert.ok(!workflow.includes('npx playwright install --with-deps'));
});
test('shared protocol gate only allows unlisted versions for the exact measured Desktop backend', async()=>{
 const probe=await readFile(new URL('../scripts/shared-protocol-probe.py',import.meta.url),'utf8');
 assert.ok(probe.includes("parser.add_argument('--expected-version', required=True)"));
 assert.ok(probe.includes('if args.expected_version not in VERSIONS and not args.desktop_bundle:'));
 assert.ok(probe.includes("evidence.get('backendVersion') != args.expected_version"));
});
test('Windows shared protocol fixture keeps CODEX_HOME outside RUNNER_TEMP', async()=>{
 const probe=await readFile(new URL('../scripts/shared-protocol-probe.py',import.meta.url),'utf8');
 assert.ok(/fixture_parent\s*=\s*os\.environ\.get\('USERPROFILE'\)\s+if os\.name == 'nt'\s+else os\.environ\.get\('RUNNER_TEMP'\)/u.test(probe));
 assert.ok(/tempfile\.mkdtemp\(prefix='rs-', dir=fixture_parent\)/u.test(probe));
});
test('Windows native process proof reuses hashes for matching expected image paths',async()=>{
 const source=await readFile(new URL('../src/server/codex-native-generation.ts',import.meta.url),'utf8');
 assert.match(source,/function MatchesExpectedImage\(\$actualPath,\$expectedPath,\$actualHash\)/u);
 assert.match(source,/GetFullPath\(\$actualPath\) -ieq \[IO\.Path\]::GetFullPath\(\$expectedPath\)/u);
 assert.ok(source.includes('MatchesExpectedImage $exe $expectedExecutable $hash'));
 assert.ok(source.includes('MatchesExpectedImage $helper.MainModule.FileName $p.helperExecutable $helperHash'));
});
test('Windows native proof failure details use only the existing bounded CI diagnostic flag',async()=>{
 const source=await readFile(new URL('../src/server/codex.ts',import.meta.url),'utf8');
 assert.match(source,/process\.env\.RELE_CI_SHARED_DIAGNOSTICS\s*===\s*'1'/u);
 assert.match(source,/onProofFailure/u);
 assert.match(source,/event:\s*'codex-native-proof-failure'/u);
});
test('the current signed Desktop backend is covered by every supported Codex probe', async()=>{
 const version='0.167.0-alpha.4.1';
 for(const file of ['../scripts/protocol-probe.py','../scripts/managed-protocol-probe.py','../scripts/shared-protocol-probe.py','../scripts/windows/ci-standard-user-canary.ps1']) {
  const source=await readFile(new URL(file,import.meta.url),'utf8');
  assert.ok(source.includes(version),`${file} must test the current signed Desktop backend`);
 }
});
test('signed Desktop fixture defines complete inert MCP transports for its enable overrides', async()=>{
 const probe=await readFile(new URL('../scripts/shared-protocol-probe.py',import.meta.url),'utf8');
 const start=probe.indexOf("scenario_config += f'''");
 assert.notEqual(start,-1,'Desktop fixture must add isolated MCP definitions');
 const fixture=probe.slice(start,probe.indexOf("\n        (home / 'config.toml')",start));
 assert.ok(fixture.includes('[mcp_servers.codex_app]'));
 assert.ok(fixture.includes('[mcp_servers.code-review]'));
 assert.equal((fixture.match(/command=/gu)??[]).length,2);
 assert.equal((fixture.match(/enabled=false/gu)??[]).length,2);
 assert.ok(fixture.includes('disabled-mcp-fixture'));
});
test('actual Desktop CI provisions the verified MSIX before standard-user discovery', async()=>{
 const canary=await readFile(new URL('../scripts/windows/ci-standard-user-canary.ps1',import.meta.url),'utf8');
 const workflow=await readFile(new URL('../.github/workflows/verify.yml',import.meta.url),'utf8');
 const provision=workflow.indexOf('name: Provision the signed Desktop package for disposable users');
 const standardUser=workflow.indexOf('name: Verify Windows installer and native shared gates as a standard user');
 const discover=canary.indexOf('shared-actual-desktop');
 assert.ok(provision>=0 && provision<standardUser,'provision the signed package before the standard-user profile is created');
 const standardUserStep=workflow.slice(standardUser,workflow.indexOf('\n      - name:',standardUser+1));
 assert.match(standardUserStep,/RELE_CI_SHARED_DIAGNOSTICS:\s*['"]?1/u,'enable bounded discovery diagnostics only for the Windows standard-user gate');
 const provisioningStep=workflow.slice(provision,standardUser);
 assert.match(provisioningStep,/Get-AuthenticodeSignature/u,'verify the package signature before provisioning');
 assert.match(provisioningStep,/Get-FileHash .*SHA256/u,'bind provisioning to the inspected package bytes');
 assert.match(provisioningStep,/Add-AppxProvisionedPackage -Online -PackagePath \$package -SkipLicense/u,'provision the package for new users on the disposable runner');
 assert.match(provisioningStep,/Get-AppxProvisionedPackage -Online/u,'verify the package is provisioned before creating the test user');
 assert.match(workflow,/cleanup desktop desktop_provision standard_user voice_windows/u,'require successful provisioning as part of the Windows CI gate');
 assert.doesNotMatch(canary,/Add-AppxPackage/u,'the ordinary-user canary must not install a packaged service');
 assert.match(canary,/Get-AppxPackage -Name \$name/u,'verify registration in the same user profile');
 assert.ok(canary.includes(').Hash.ToLowerInvariant() -ne $inventory.package.sha256'),'bind installation to the verified MSIX bytes');
 assert.match(workflow,/ci-standard-user-canary\.ps1 -RunGates .*?-DesktopPackage/u,'pass the verified MSIX to the canary');
});
test('explicit Windows diagnostics reach only the isolated Rele driver', async()=>{
 const probe=await readFile(new URL('../scripts/shared-protocol-probe.py',import.meta.url),'utf8');
 const canary=await readFile(new URL('../scripts/windows/ci-standard-user-canary.ps1',import.meta.url),'utf8');
 const driverStart=probe.indexOf('    async def driver('),driverEnd=probe.indexOf('\n    async def desktop(',driverStart);
 assert.ok(driverStart>=0 && driverEnd>driverStart,'shared probe must define its isolated Rele driver');
 const driver=probe.slice(driverStart,driverEnd),baseEnv=probe.slice(probe.indexOf('    base_env = {'),probe.indexOf('\n    base_env.update',probe.indexOf('    base_env = {')));
 const childStart=canary.indexOf("if ($Mode -eq 'Child') {"),parentMarker=canary.indexOf('$marker = @{ nonce = $Nonce',childStart);
 assert.ok(childStart>=0 && parentMarker>childStart,'standard-user canary must define child and parent marker paths');
 const child=canary.slice(childStart,parentMarker),parent=canary.slice(parentMarker);
 assert.match(parent,/sharedDiagnostics = \[bool\]\(\$RunGates\.IsPresent -and \$DesktopBundle -and \$env:RELE_CI_SHARED_DIAGNOSTICS -eq '1'\)/u,'serialize diagnostics only for an explicit signed Desktop gate');
 assert.match(child,/foreach \(\$entry in @\(Get-ChildItem Env:\)\) \{ Remove-Item[^}]+\}\s*\$env:SystemRoot[\s\S]*?if \(\[bool\]\$marker\.sharedDiagnostics\) \{\s*\$env:RELE_CI_SHARED_DIAGNOSTICS = '1'\s*\}/u,'restore only the explicit marker after the clean child environment is built');
 assert.doesNotMatch(baseEnv,/RELE_CI_SHARED_DIAGNOSTICS/u,'do not pass the diagnostic flag to every isolated child');
 assert.match(driver,/if os\.name == 'nt' and os\.environ\.get\('RELE_CI_SHARED_DIAGNOSTICS'\) == '1'/u,
  'forward the explicit diagnostics flag to all isolated Windows shared-driver probes');
 assert.doesNotMatch(driver,/if args\.desktop_bundle and not args\.installed_desktop and os\.environ\.get\('RELE_CI_SHARED_DIAGNOSTICS'\)/u,
  'do not omit diagnostics for packaged Codex version probes');
 assert.match(driver,/os\.environ\.get\('RELE_CI_SHARED_DIAGNOSTICS'\) == '1'/u,'require the explicit CI diagnostic switch');
 assert.match(driver,/spawn\(command, driver_env, REPO\)/u,'forward the switch only to the Rele driver');
});
test('shared native gate records bounded request state without payloads on timeout', async()=>{
 const probe=await readFile(new URL('../scripts/shared-protocol-probe.py',import.meta.url),'utf8');
 const start=probe.indexOf('    async def held_request_evidence('),end=probe.indexOf('\n    async def wait_records',start);
 assert.ok(start>=0 && end>start,'shared probe must define bounded timeout evidence');
 const evidence=probe.slice(start,end);
 for(const field of ['providerRequestCount','engineRequests','nativeTurnStatus','observedTurns','eventId','status','turnId']) assert.ok(evidence.includes(field),`timeout evidence must include ${field}`);
 for(const field of ['engineApprovals','queuedProviderActionTypes','driverOperations','reconciliationStageTrace']) assert.ok(evidence.includes(field),`timeout evidence must include ${field}`);
 for(const field of ['text','payload','input','content','prompt']) assert.ok(!evidence.includes(field),`timeout evidence must exclude ${field}`);
 assert.match(evidence,/engine_snapshot = await asyncio\.wait_for\(engine\.command\('snapshot'\), 5\)[\s\S]*?evidence\['engineProtocolEvents'\] = engine_snapshot\.get\('observedProtocolEvents', \[\]\)\[-24:\][\s\S]*?evidence\['driverOperations'\] = engine_snapshot\.get\('driverOperations', \[\]\)[\s\S]*?evidence\['reconciliationStageTrace'\] = engine_snapshot\.get\('reconciliationStageTrace', \[\]\)\[-32:\]/u,'preserve bounded protocol and stage metadata from the Rele engine snapshot');
 assert.match(evidence,/native_snapshot = await asyncio\.wait_for\(peer\.call\('thread\/read'[\s\S]*?evidence\['nativeTurnStatus'\] = native_snapshot/u,'keep native thread state separate from the engine snapshot');
 const driver=await readFile(new URL('../scripts/probe-shared-codex.ts',import.meta.url),'utf8');
 for(const field of ['dispatch','initialMessage.ensure','slackSync.drain','subscribe','backgroundTerminals','enqueue','driverOperations']) assert.ok(driver.includes(field),`shared driver must trace ${field}`);
 for(const field of ['completionObservations','reconciliationTrace','reconciliationStageTrace','rpcTrace']) assert.ok(driver.includes(field),`shared driver must trace ${field}`);
 const diagnostics=await readFile(new URL('../scripts/shared-probe-diagnostics.mjs',import.meta.url),'utf8');
 for(const field of ['completionObservations','reconciliationTrace','reconciliationStageTrace','rpcTrace']) assert.ok(diagnostics.includes(field),`timeout evidence must include ${field}`);
 assert.doesNotMatch(driver,/codex\.diagnostics\s*=\s*observe\('diagnostics'/u,'snapshot polling must not evict useful driver operations from the bounded trace');
 assert.match(driver,/driverOperations:\s*driverOperations\.slice\(-\d+\)/u,'bound the operation trace in snapshots');
 assert.match(driver,/completionObservations:\s*completionObservations\.slice\(-\d+\)/u,'bound completion matching observations');
 assert.match(driver,/reconciliationTrace:\s*reconciliationTrace\.slice\(-\d+\)/u,'bound Engine reconciliation observations');
 assert.match(driver,/reconciliationStageTrace:\s*reconciliationStageTrace\.slice\(-\d+\)/u,'bound awaited reconciliation stages');
 assert.match(driver,/rpcTrace:\s*rpcTrace\.slice\(-\d+\)/u,'bound app-server RPC observations');
 assert.match(probe,/except \(TimeoutError, RuntimeError\):\s*report\['heldRequestTimeout'\] = await held_request_evidence\(engine, peer, thread\)/u,'capture the safe snapshot when the native wait or provider wait fails');
 const cancel=probe.indexOf("await engine.command('ingest', platform='telegram', eventId='cancel'");
 const afterCancel=probe.indexOf('await asyncio.wait_for(wait_records(before + 2), 25)',cancel);
 assert.ok(cancel>=0 && afterCancel>cancel,'bounded shell probe must wait for the request result');
 assert.match(probe.slice(cancel,afterCancel),/report\['cancellationRequestTimeout'\] = await held_request_evidence\(engine, peer, thread\)/u,'capture queue and request state before failing the shell timeout');
 const canary=await readFile(new URL('../scripts/windows/ci-standard-user-canary.ps1',import.meta.url),'utf8');
 assert.match(canary,/if \(\$null -ne \$timeoutReport\.cancellationRequestTimeout\) \{\s*\$result \| Add-Member -Force -NotePropertyName cancellationRequestTimeout -NotePropertyValue \$timeoutReport\.cancellationRequestTimeout\s*\}/u,'forward the cancellation timeout snapshot into the Windows job failure report');
});
test('shared fixture settles ordinary intake but not the synthetic lost queue ACK', async()=>{
 const driver=await readFile(new URL('../scripts/probe-shared-codex.ts',import.meta.url),'utf8');
 const start=driver.indexOf("if (command.action === 'ingest') {");
 const end=driver.indexOf("} else if (command.action === 'wait')",start);
 assert.ok(start>=0 && end>start,'shared driver must define an ingest action before provider polling');
 const ingest=driver.slice(start,end);
 assert.match(ingest,/await engine!\.receive\(/u,'persist the inbound fixture event before replying');
 assert.match(ingest,/if \(command\.loseAck !== true\) await engine!\.settled\(\);/u,'keep ordinary fixture processing deterministic but let lost-ACK reconciliation stay asynchronous');
 const probe=await readFile(new URL('../scripts/shared-protocol-probe.py',import.meta.url),'utf8');
 const held=probe.indexOf("await engine.command('ingest', platform='telegram', eventId='held-telegram'");
 const next=probe.indexOf('turn_started = await peer.wait(',held);
 assert.ok(held>=0 && next>held,'lost-ACK probe must ingest before waiting for the native request');
 assert.match(probe.slice(held,next),/loseAck=True/u,'only the held native request bypasses settled reconciliation');
});
test('Windows shared shell startup wait includes both bounded native identity proofs', async()=>{
 const probe=await readFile(new URL('../scripts/shared-protocol-probe.py',import.meta.url),'utf8');
 assert.match(probe,/ENGINE_SHARED_SHELL_START_TIMEOUT_SECONDS\s*=\s*65/u);
 const cancel=probe.indexOf("await engine.command('ingest', platform='telegram', eventId='cancel'");
 const afterCancel=probe.indexOf("raise AssertionError('Shell neither started nor requested approval')",cancel);
 assert.ok(cancel>=0 && afterCancel>cancel,'shell startup wait must remain bounded');
 assert.match(probe.slice(cancel,afterCancel),/deadline\s*=\s*asyncio\.get_running_loop\(\)\.time\(\)\s*\+\s*ENGINE_SHARED_SHELL_START_TIMEOUT_SECONDS/u);
});
test('Windows shared driver read deadline covers both native identity proofs', async()=>{
 const probe=await readFile(new URL('../scripts/shared-protocol-probe.py',import.meta.url),'utf8');
 const timeout=Number(probe.match(/ENGINE_READ_TIMEOUT_SECONDS\s*=\s*(\d+)/u)?.[1]);
 assert.ok(timeout >= 65,'allow the two 30-second native identity proofs plus fixture overhead');
});
test('Windows fixture stop wait exceeds the nested owner shutdown deadline', async()=>{
 const probe=await readFile(new URL('../scripts/shared-protocol-probe.py',import.meta.url),'utf8');
 const fixture=await readFile(new URL('../scripts/installer-codex-fixture.mjs',import.meta.url),'utf8');
 const ownerStop=probe.slice(probe.indexOf('    async def owner_stop(env):'),probe.indexOf('\n    async def native(env, operation):'));
 const outerTimeout=Number(ownerStop.match(/output_and_exit\(process,\s*(\d+)\)/u)?.[1])*1000;
 const innerTimeout=Number(fixture.match(/timeout:\s*scheduledDirectory\s*\?\s*75_000\s*:\s*(\d+)_000/u)?.[1])*1000;
 assert.match(ownerStop,/stopInstallerCodex\(target\)/u,'owner-stop uses the standard fixture shutdown deadline');
 assert.ok(outerTimeout >= innerTimeout+10_000,'allow 10 seconds for the nested Windows shutdown helper to exit');
});
test('Windows canary forwards only bounded timeout evidence from the failed Desktop probe', async()=>{
 const canary=await readFile(new URL('../scripts/windows/ci-standard-user-canary.ps1',import.meta.url),'utf8');
 const start=canary.indexOf("$timeoutReportPath = Join-Path $FixtureRoot 'reports\\shared-results-actual-desktop.json'");
 const end=canary.indexOf("foreach ($log in @('stdout.log'",start);
 assert.ok(start>=0 && end>start,'failed Windows canary must read the Desktop report from its fixture directory');
 const relay=canary.slice(start,end);
 assert.match(relay,/\.heldRequestTimeout/u,'forward the probe timeout snapshot');
 assert.match(relay,/NotePropertyName heldRequestTimeout/u,'attach only the bounded snapshot to the failure receipt');
 assert.match(relay,/\.afterShellCancelWaitFailure/u,'forward bounded evidence from the Windows shell-cancel recovery failure');
 assert.match(relay,/NotePropertyName afterShellCancelWaitFailure/u,'attach only the bounded shell-cancel evidence to the failure receipt');
 assert.doesNotMatch(relay,/NotePropertyName (?:report|sharedReport)/u,'do not forward the full probe report');
 assert.ok(canary.indexOf('$result | ConvertTo-Json -Depth 6',end)>end,'serialize the bounded evidence into the canary receipt');
});
test('Windows parent failure prints only bounded shared-gate counts and states', async()=>{
 const canary=await readFile(new URL('../scripts/windows/ci-standard-user-canary.ps1',import.meta.url),'utf8');
 const start=canary.indexOf("$sharedDiagnosticName = 'shared-results-actual-desktop.json'");
 const end=canary.indexOf("if ($cleanupFailures.Count -ne 0)",start);
 assert.ok(start>=0 && end>start,'parent cleanup must summarize the report for the failed shared gate');
 const summary=canary.slice(start,end);
 assert.match(summary,/\[string\]\$result\.stage -match '\^shared-\(\\d\+\\\.\\d\+\\\.\\d\+\(\?:-\[0-9A-Za-z\.\]\+\)\?\)\$'/u,'select version reports only from a validated shared-gate stage');
 assert.match(summary,/\$sharedDiagnosticName = 'shared-results-' \+ \$Matches\[1\] \+ '\.json'/u,'read the report for the failed Codex version');
 assert.match(summary,/Join-Path \$sourceRoot \$sharedDiagnosticName/u,'resolve the selected report under the known source directory');
 for(const field of ['providerRequestCount','engineRequestStatuses','approvalStatuses','nativeTurnStatus','nativeRequestLookup','nativeRequestErrorType','nativeRequestState',
  'nativeRequestTurnAssigned','nativeRequestQueuedSubmissionFound','nativeRequestMixed','nativeRequestFinalAnswerPresent',
  'observedTurnStarts','observedTurnCompletions','Write-Output']) {
  assert.ok(summary.includes(field),`print the bounded timeout field ${field}`);
 }
 assert.doesNotMatch(summary,/stderrTail|exception|payload|requestId|turnId|sharedReport/u,'never print raw errors, payloads, IDs, or the complete report');
});
test('shared cancellation diagnostics preserve the original error if snapshot fails', async()=>{
 const probe=await readFile(new URL('../scripts/probe-shared-codex.ts',import.meta.url),'utf8');
 const start=probe.indexOf('try { await engine!.cancel(command.requestId!); } catch (error) {');
 const end=probe.indexOf("\n      } else if (command.action === 'close')",start);
 assert.ok(start>=0 && end>start,'shared probe must define cancellation failure diagnostics');
 const failure=probe.slice(start,end);
 assert.match(failure,/try\s*\{\s*state = await snapshot\(command\.processId\);\s*\}\s*catch\s*\(diagnostic\)/u,
  'contain a failed native snapshot while handling a cancel error');
 assert.match(failure,/snapshotErrorType/u,'record only the diagnostic exception type');
 assert.match(failure,/identityFailure: safeIdentityFailure/u,'report only a bounded terminal identity failure category');
 assert.match(failure,/\['server-id-changed', 'target-generation-invalid', 'server-generation-unconfirmed', 'server-generation-changed', 'terminal-ambiguous', 'terminal-process-changed'\]/u,'allowlist terminal identity diagnostics without reporting identifiers');
 assert.ok(failure.indexOf("event: 'shared-cancel-diagnostic'")<failure.indexOf('throw error;'),
  'emit best-effort diagnostics and rethrow the original cancel error');
});
test('shared cancellation failure records bounded provider and native completion evidence', async()=>{
 const probe=await readFile(new URL('../scripts/shared-protocol-probe.py',import.meta.url),'utf8');
 const wait=probe.indexOf("completed = await engine.command('wait')",probe.indexOf("eventId='after-shell-cancel'"));
 assert.ok(wait>=0,'shared cancellation fixture must wait for the next origin request');
 const failure=probe.slice(wait-180,wait+260);
 assert.match(failure,/try:\s*\n\s*completed = await engine\.command\('wait'\)\s*\n\s*except RuntimeError:/u,
  'capture evidence when the native Engine driver exits during the completion wait');
 assert.match(failure,/held_request_evidence\(engine, peer, thread\)/u,
  'reuse the bounded native snapshot and observed turn evidence');
 assert.match(probe,/providerTrace/u,'failure evidence must include mock-provider action/response stages');
 assert.match(probe,/provider_trace\[-8:\]/u,'limit the diagnostic to the latest provider events');
 assert.match(probe,/except \(TimeoutError, RuntimeError\):\s*report\['approvalWaitFailure'\] = await held_request_evidence\(engine, peer, thread\)/u,'capture approval protocol evidence if the Windows driver exits or times out');
 assert.doesNotMatch(probe,/provider_trace.*body|providerTrace.*body/u,'never include synthetic request bodies in the report');
 const driver=await readFile(new URL('../scripts/probe-shared-codex.ts',import.meta.url),'utf8');
 assert.match(driver,/codex\.findRequest\(threadId, target\.id, \[target\.id\], true\)/u,'read the native receipt for the unresolved synthetic request');
 assert.match(driver,/summarizeSharedNativeRequest\(native\.location\)/u,'publish only bounded native request state');
 assert.match(driver,/delay\(5000\)\.then\(\(\) => \(\{ timeout: true as const \}\)\)/u,'bound the additional read-only history query');
});
test('shared Windows cancellation probe waits for bounded native generation proofs', async()=>{
 const probe=await readFile(new URL('../scripts/shared-protocol-probe.py',import.meta.url),'utf8');
 const driverStart=probe.indexOf('class EngineDriver:');
 const driverEnd=probe.indexOf('\n    async def close(self):',driverStart);
 assert.ok(driverStart>=0 && driverEnd>driverStart,'shared probe must define its Engine driver');
 const driver=probe.slice(driverStart,driverEnd);
 assert.match(probe,/ENGINE_CANCEL_READ_TIMEOUT_SECONDS\s*=\s*720/u,
  'allow the finite sequence of 30-second Windows process proofs in the cancellation path');
 assert.match(driver,/timeout = ENGINE_CANCEL_READ_TIMEOUT_SECONDS if action == 'cancel' else ENGINE_WAIT_READ_TIMEOUT_SECONDS if action == 'wait' else ENGINE_READ_TIMEOUT_SECONDS/u,
  'use action-specific deadlines for cancellation diagnostics and normal completion waits');
 assert.match(driver,/return await self\.read\(timeout\)/u,'use the action-specific response deadline');
});
test('shared Windows cancellation fixture outlives the bounded native proof window without sleeping it out', async()=>{
 const probe=await readFile(new URL('../scripts/shared-protocol-probe.py',import.meta.url),'utf8');
 assert.ok(/shell_delay\s*=\s*ENGINE_CANCEL_READ_TIMEOUT_SECONDS\s*\+\s*120 if os\.name == 'nt' else 60/u.test(probe),
  'keep the delayed marker beyond the 12-minute native cancellation read window');
 const cancel=probe.indexOf("cancelled = await engine.command('cancel'");
 const stopped=probe.indexOf("assert not cancelled['probeProcessAlive']",cancel);
 const deadline=probe.indexOf('assert asyncio.get_running_loop().time() < shell_deadline',stopped);
 const marker=probe.indexOf('assert not late_file.exists()',deadline);
 assert.ok(cancel>=0 && stopped>cancel && deadline>stopped && marker>deadline,
  'confirm process stop and marker absence before the bounded fixture timer can fire');
 assert.doesNotMatch(probe,/await asyncio\.sleep\(max\(0,\s*shell_deadline/u,
  'do not wait for the marker timer after proving the exact process is stopped');
});
test('shared Windows lost-ACK probe recovers from native turn start before provider completion', async()=>{
 const probe=await readFile(new URL('../scripts/shared-protocol-probe.py',import.meta.url),'utf8');
 const held=probe.indexOf("await engine.command('ingest', platform='telegram', eventId='held-telegram'");
 const started=probe.indexOf('turn_started = await peer.wait(',held);
 const close=probe.indexOf('await engine.close(); engine = None',started);
 const restart=probe.indexOf('engine, restarted = await driver(env, workspace, thread=thread)',close);
 const release=probe.indexOf('hold.set()',restart);
 const completed=probe.indexOf("completed = await engine.command('wait')",release);
 const provider=probe.indexOf("assert len(records) == before + 1",completed);
 assert.ok(held>=0 && started>held && close>started && restart>close && release>restart && completed>release && provider>completed,
  'confirm native turn start, restart Rele, release the provider and only then assert exactly one model request');
 assert.doesNotMatch(probe.slice(held,close),/engine\.command\('wait', status='running'\)/u,
  'do not wait for Engine.settled while the provider response is deliberately held');
});
test('Windows owner probe avoids an immediate duplicate Task Scheduler COM query', async()=>{
 const probe=await readFile(new URL('../scripts/smoke-windows-codex-control.mjs',import.meta.url),'utf8');
 const native=await readFile(new URL('../scripts/windows/Rele.cs',import.meta.url),'utf8');
 const start=probe.indexOf("phase = 'start-initial';");
 const snapshot=probe.indexOf('const taskSnapshot = () => powershell(',start);
 assert.ok(start>=0 && snapshot>start,'owner probe must start Codex before capturing the Task Scheduler snapshot');
 const nativeStart=native.indexOf('private static Dictionary<string, object> StartCodexWebSocket(');
 const nativeEnd=native.indexOf('\n    private static void RemoveCodexWebSocketStartup()',nativeStart);
 assert.ok(nativeStart>=0 && nativeEnd>nativeStart,'native start command must have a bounded implementation');
 const nativeBody=native.slice(nativeStart,nativeEnd);
 const registration=nativeBody.indexOf('RegisterCodexWebSocketTask(owner, directory);');
 const verification=nativeBody.indexOf('OwnedCodexWebSocketTask(TaskFolder(), owner, directory);',registration);
 const launch=nativeBody.indexOf('task.Run(null);',verification);
 const success=nativeBody.indexOf('return receipt;',launch);
 assert.ok(registration>=0 && verification>registration && launch>verification && success>launch,
  'the native command must register and verify the Task before returning a successful start receipt');
 const initial=probe.slice(start,snapshot);
 assert.match(initial,/const first = await start\(\);[\s\S]*?assert\.equal\(control\.taskName, `\$\{task\}-Codex`\)/u,
  'validate the task identity returned by the native command');
 assert.doesNotMatch(initial,/scheduledTaskExists|powershell\(/u,
  'the native start path already registers and verifies the Task before the later detailed snapshot');
 assert.match(probe.slice(snapshot),/\$task=\$scheduler\.GetFolder\('\\\\'\)\.GetTask\(\$env:RELE_CONTROL_TASK\)/u,
  'retain the later detailed Task Scheduler inspection');
 assert.ok(probe.includes('assert.equal(scheduledTaskExists(`${task}-Codex`), false);'),
  'retain the independent check that stopping Codex removes its Task');
});
test('Windows owner status proves the listener PID without a second PowerShell TCP query',async()=>{
 const probe=await readFile(new URL('../scripts/smoke-windows-codex-control.mjs',import.meta.url),'utf8');
 const native=await readFile(new URL('../scripts/windows/Rele.cs',import.meta.url),'utf8');
 const live=probe.slice(probe.indexOf("phase = 'status-live';"),probe.indexOf("phase = 'native-initialize';"));
 assert.ok(live.includes("assert.equal(liveControl.status, 'alreadyRunning')") && live.includes("for (const key of ['endpoint', 'processId'"),
  'reuse the status response already bound to the started Codex PID');
 assert.doesNotMatch(live,/Get-NetTCPConnection/u,'avoid a second PowerShell TCP table query after codex-status');
 const statusStart=native.indexOf('private static Dictionary<string, object> CodexWebSocketStatus(');
 const statusEnd=native.indexOf('\n    private static Dictionary<string, object> StartCodexWebSocket',statusStart);
 const status=native.slice(statusStart,statusEnd);
 assert.match(status,/CodexWebSocketReceipt\(owner,[\s\S]*?"alreadyRunning"\)/u,'codex-status must use the validated runtime receipt');
 const receiptStart=native.indexOf('private static Dictionary<string, object> ReadCodexWebSocketReceipt(');
 const receiptEnd=native.indexOf('\n    private static Dictionary<string, object> CodexWebSocketStatus',receiptStart);
 assert.match(native.slice(receiptStart,receiptEnd),/OwnCodexListener\(owner\.Endpoint, native\.Id\)/u,
  'the validated runtime receipt must bind the listener to the native PID');
});
test('fixture cleanup skips a reused host PID and still drains its exact Task', async()=>{
 const cleanup=await readFile(new URL('../scripts/installer-codex-fixture.mjs',import.meta.url),'utf8');
 const hostStart=cleanup.indexOf('$hostProcess = Get-Process -Id $receipt.hostPid');
 const identityStart=cleanup.indexOf('$identity = Get-CimInstance Win32_Process',hostStart);
 assert.ok(hostStart>=0 && identityStart>hostStart,'fixture cleanup must verify the receipt host process');
 assert.match(cleanup.slice(hostStart,identityStart),/if \(\$hostProcess\.Path -ne \(Join-Path \$directory 'Rele\.Process\.exe'\) -or[\s\S]*?\) \{ continue \}/u,
  'a reused PID must be left untouched while cleanup proceeds to other owned receipts');
 assert.match(cleanup,/if \(\$task\.State -notin @\(1,3\) -or \$task\.GetInstances\(0\)\.Count -ne 0\) \{ throw/u,
  'cleanup must retain the fixture if its exact Task still has an instance');
});
