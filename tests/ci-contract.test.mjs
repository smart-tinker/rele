import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, mkdir, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertStorageApproval, assertSteps, writeBundle, verifyBundles } from '../scripts/ci-contract.mjs';
const sha = 'a'.repeat(40), run = '123', attempt = '1', version = '0.1.2-rc.1';
const now = Date.parse('2026-11-09T10:00:00Z');
const approval = { checkedAt: new Date(now).toISOString(), freeBytes: 250 * 1024 ** 2, paidUsageBlocked: true };
test('storage fails closed for absent, stale, paid or insufficient allowance', () => {
 assert.doesNotThrow(() => assertStorageApproval(approval, 0, now));
 for (const value of [null, {...approval, paidUsageBlocked:false}, {...approval, freeBytes:0}, {...approval, checkedAt:'invalid'}, {...approval, checkedAt:'2026-11-08T10:00:00Z'}, {...approval, checkedAt:'2026-11-10T10:00:00Z'}]) assert.throws(() => assertStorageApproval(value, 0, now));
 assert.throws(() => assertStorageApproval(approval, 400 * 1024 ** 2, now));
 assert.throws(() => assertStorageApproval(approval, NaN, now));
});
test('missing, skipped and failed required steps cannot pass', () => {
 assert.doesNotThrow(() => assertSteps({a:{outcome:'success',conclusion:'success'}}, ['a']));
 for (const outcome of ['skipped','failure','cancelled']) assert.throws(() => assertSteps({a:{outcome,conclusion:'success'}}, ['a']));
 assert.throws(() => assertSteps({}, ['a']));
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
test('unlisted file is rejected',()=>fixture(async root=>{
 await writeFile(path.join(root,'linux','extra'),'extra');await assert.rejects(verifyBundles(root,version,sha,run,attempt));
}));
test('symlink cannot substitute a package',()=>fixture(async root=>{
 const file=path.join(root,'linux',`rele-${version}-linux-x64.deb`);await rm(file);
 await symlink(path.join(root,'windows'),file,process.platform==='win32'?'junction':undefined);
 await assert.rejects(verifyBundles(root,version,sha,run,attempt));
}));
test('publisher refuses an advanced main or existing tag before any write', ()=>fixture(async root=>{
 const {publishCandidate}=await import('../scripts/ci-publish.mjs');
 for(const advanced of [true,false]) {
  const calls=[];
  const api=async(route,options={})=>{calls.push(options.method??'GET');if(route.endsWith('/git/ref/heads/main'))return {object:{sha:advanced?'b'.repeat(40):sha}};return {exists:true};};
  await assert.rejects(publishCandidate(api,await verifyBundles(root,version,sha,run,attempt),'owner/repo',version,sha,[11,12]));
  assert.ok(calls.length > 0 && calls.every(x=>x==='GET')); 
 }
}));
test('publisher uploads verified bytes to a new draft, then removes only this run artifacts',()=>fixture(async root=>{
 const {publishCandidate}=await import('../scripts/ci-publish.mjs');
 const bundle=await verifyBundles(root,version,sha,run,attempt), calls=[];
 const api=async(route,options={})=>{
  calls.push({route,...options});
  if(route.endsWith('/git/ref/heads/main'))return {object:{sha}};
  if(!options.method)return null;
  if(options.upload){const name=new URL('https://uploads.github.com'+route).searchParams.get('name');return {name,size:options.body.length,digest:'sha256:'+createHash('sha256').update(options.body).digest('hex')};}
  if(options.method==='POST'){assert.equal(options.body.draft,true);return {id:77,html_url:'https://github.com/owner/repo/releases/77'};}
  return null;
 };
 const result=await publishCandidate(api,bundle,'owner/repo',version,sha,[11,12]);
 assert.equal(result.id,77);assert.equal(calls.filter(x=>x.upload).length,9);
 assert.deepEqual(calls.slice(-2).map(x=>[x.method,x.route]),[['DELETE','/repos/owner/repo/actions/artifacts/11'],['DELETE','/repos/owner/repo/actions/artifacts/12']]);
}));
test('workflow requirement lists tolerate empty conditional groups', async()=>{
 const {spawnSync}=await import('node:child_process');
 for(const required of ['install unit   ','install unit linux ','install unit  windows']) {
  const steps=Object.fromEntries(required.trim().split(/\s+/u).map(id=>[id,{outcome:'success',conclusion:'success'}]));
  const result=spawnSync(process.execPath,['scripts/ci.mjs','steps'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,STEPS:JSON.stringify(steps),REQUIRED:required},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
 }
});
test('unconfirmed upload leaves transfers intact for reconciliation',()=>fixture(async root=>{
 const {publishCandidate}=await import('../scripts/ci-publish.mjs');
 const bundle=await verifyBundles(root,version,sha,run,attempt),calls=[];
 const api=async(route,options={})=>{
  calls.push(options.method??'GET');
  if(route.endsWith('/git/ref/heads/main'))return {object:{sha}};
  if(!options.method)return null;
  if(options.upload)return {name:'wrong',size:0,digest:'wrong'};
  return {id:77};
 };
 await assert.rejects(publishCandidate(api,bundle,'owner/repo',version,sha,[11,12]));
 assert.equal(calls.includes('DELETE'),false);
}));
test('one required CI gate waits for every OS matrix job', async()=>{
 const workflow=await readFile(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
 const start=workflow.indexOf('\n  gate:\n');
 assert.notEqual(start,-1,'missing aggregate gate job');
 const end=workflow.indexOf('\n  publish:\n',start);
 assert.notEqual(end,-1,'gate must precede the publisher');
 const gate=workflow.slice(start,end);
 assert.match(gate,/name: CI gate/u);
 assert.match(gate,/needs: verify/u);
 assert.match(gate,/always\(\)/u);
 assert.match(gate,/github\.event\.repository\.private == false/u);
 assert.match(gate,/needs\.verify\.result/u);
 const publisher=workflow.slice(workflow.indexOf('\n  publish:\n'));
 assert.match(publisher,/needs: \[verify, gate\]/u);
});
