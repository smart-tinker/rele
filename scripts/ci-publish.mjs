import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { packageNames, PLATFORM_LIMIT, verifyPlatformBundle } from './ci-contract.mjs';

function context(value) {
 assert.match(value.repository,/^[\w.-]+\/[\w.-]+$/u);
 assert.match(value.version,/^\d+\.\d+\.\d+-rc\.\d+$/u);assert.match(value.commit,/^[a-f0-9]{40}$/u);
 assert.match(value.runId,/^[1-9]\d*$/u);assert.match(value.attempt,/^[1-9]\d*$/u);
 return `/repos/${value.repository}`;
}
function body(candidate, verified=false) {
 return `Rele candidate ${candidate.commit}; run ${candidate.runId}; attempt ${candidate.attempt}. Verification ${verified?'passed':'pending'}.\nReal Desktop and messenger acceptance is still required.`;
}
async function currentMain(api, candidate) {
 assert.equal((await api(`${context(candidate)}/git/ref/heads/main`)).object.sha,candidate.commit,'Main advanced; verify a new candidate');
}
function draft(release, candidate, releaseId, verified=false) {
 assert.ok(Number.isSafeInteger(releaseId) && releaseId>0,'Invalid draft release ID');
 assert.equal(release?.id,releaseId);assert.equal(release.draft,true,'Candidate must remain a draft');assert.equal(release.prerelease,true);
 assert.equal(release.tag_name,`v${candidate.version}`);assert.equal(release.target_commitish,candidate.commit);
 assert.equal(release.body,body(candidate,verified),'Draft source/run/attempt or verification state changed');
 return release;
}
async function checkedDraft(api, candidate, releaseId) {
 const base=context(candidate);
 assert.ok(Number.isSafeInteger(releaseId) && releaseId>0,'Invalid draft release ID');
 const release=draft(await api(`${base}/releases/${releaseId}`),candidate,releaseId);
 const tag=await api(`${base}/git/ref/tags/v${candidate.version}`);
 if(tag)assert.ok(tag.object?.type==='commit' && tag.object.sha===candidate.commit,'Candidate tag changed');
 await currentMain(api,candidate);
 return release;
}
function expectedAssets(version) {
 return ['linux','windows'].flatMap(platform=>[
  ...packageNames(platform,version).map(name=>({name,platform,localName:name,limit:PLATFORM_LIMIT})),
  {name:`${platform}-evidence.json`,platform,localName:'evidence.json',limit:65536},
 ]);
}
function assetSet(assets, expected) {
 assert.ok(Array.isArray(assets));assert.deepEqual(assets.map(item=>item.name).sort(),expected.map(item=>item.name).sort(),'Unexpected draft asset set');
 assert.equal(new Set(assets.map(item=>item.id)).size,assets.length);
 for(const asset of assets) {
  assert.ok(Number.isSafeInteger(asset.id) && asset.id>0);
  assert.ok(Number.isSafeInteger(asset.size) && asset.size>0 && asset.size<=expected.find(item=>item.name===asset.name).limit,'Invalid draft asset size');
  assert.match(asset.digest,/^sha256:[a-f0-9]{64}$/u);
 }
}
function confirmed(asset, name, data) {
 assert.equal(asset?.name,name);assert.equal(asset.size,data.length);
 assert.equal(asset.digest,'sha256:'+createHash('sha256').update(data).digest('hex'),'Uploaded or downloaded bytes were not confirmed');
}
async function upload(api, base, releaseId, name, data) {
 const asset=await api(`${base}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,{method:'POST',body:data,upload:true});
 confirmed(asset,name,data);
}
export async function prepareCandidate(api, candidate) {
 const base=context(candidate);await currentMain(api,candidate);
 assert.equal(await api(`${base}/git/ref/tags/v${candidate.version}`),null,'Tag already exists; never overwrite an RC');
 for(let page=1;;page++) {
  const releases=await api(`${base}/releases?per_page=100&page=${page}`);assert.ok(Array.isArray(releases));
  assert.ok(!releases.some(release=>release.tag_name===`v${candidate.version}`),'Release already exists; reconcile before retry');
  if(releases.length<100)break;
 }
 await currentMain(api,candidate);
 const release=await api(`${base}/releases`,{method:'POST',body:{tag_name:`v${candidate.version}`,target_commitish:candidate.commit,name:`Rele ${candidate.version} (verification pending)`,draft:true,prerelease:true,body:body(candidate)}});
 return draft(release,candidate,release?.id);
}
export async function uploadPlatform(api, candidate, releaseId, directory, platform) {
 const base=context(candidate), bundle=await verifyPlatformBundle(directory,platform,candidate.version,candidate.commit,candidate.runId,candidate.attempt);
 await checkedDraft(api,candidate,releaseId);
 const existing=await api(`${base}/releases/${releaseId}/assets?per_page=100`), expected=expectedAssets(candidate.version);
 assert.ok(Array.isArray(existing));
 assert.ok(existing.every(asset=>expected.some(item=>item.name===asset.name && item.platform!==platform)),'Own or unexpected assets already exist; reconcile before retry');
 const files=[...bundle.files,{name:`${platform}-evidence.json`,path:path.join(directory,'evidence.json')}];
 for(const file of files) {
  const data=await readFile(file.path);
  if(file.sha256) {assert.equal(data.length,file.bytes);assert.equal(createHash('sha256').update(data).digest('hex'),file.sha256);}
  await upload(api,base,releaseId,file.name,data);
 }
}
export async function downloadCandidate(api, candidate, releaseId, directory) {
 const base=context(candidate);await checkedDraft(api,candidate,releaseId);
 const assets=await api(`${base}/releases/${releaseId}/assets?per_page=100`), expected=expectedAssets(candidate.version);assetSet(assets,expected);
 await mkdir(directory);for(const platform of ['linux','windows'])await mkdir(path.join(directory,platform));
 for(const item of expected) {
  const asset=assets.find(asset=>asset.name===item.name), data=await api(`${base}/releases/assets/${asset.id}`,{download:true});
  assert.ok(Buffer.isBuffer(data));confirmed(asset,item.name,data);
  await writeFile(path.join(directory,item.platform,item.localName),data,{flag:'wx'});
 }
}
export async function publishCandidate(api, bundle, candidate, releaseId) {
 const base=context(candidate);assert.equal(bundle.files.length,8);assert.equal(bundle.evidence.length,2);
 for(const report of bundle.evidence)assert.ok(report.version===candidate.version && report.commit===candidate.commit && report.runId===candidate.runId && report.attempt===candidate.attempt,'Bundle source/run/attempt changed');
 await checkedDraft(api,candidate,releaseId);
 const assets=await api(`${base}/releases/${releaseId}/assets?per_page=100`), expected=expectedAssets(candidate.version);assetSet(assets,expected);
 for(const file of bundle.files) {
  const data=await readFile(file.path);assert.equal(data.length,file.bytes);assert.equal(createHash('sha256').update(data).digest('hex'),file.sha256);
  confirmed(assets.find(asset=>asset.name===file.name),file.name,data);
 }
 for(const report of bundle.evidence)confirmed(assets.find(asset=>asset.name===`${report.platform}-evidence.json`),`${report.platform}-evidence.json`,Buffer.from(JSON.stringify(report,null,2)+'\n'));
 const data=Buffer.from(JSON.stringify(bundle.evidence,null,2)+'\n');
 await checkedDraft(api,candidate,releaseId);await upload(api,base,releaseId,'verification.json',data);
 await checkedDraft(api,candidate,releaseId);
 const patch={name:`Rele ${candidate.version}`,draft:true,prerelease:true,body:body(candidate,true)};
 draft(await api(`${base}/releases/${releaseId}`,{method:'PATCH',body:patch}),candidate,releaseId,true);
 const result=draft(await api(`${base}/releases/${releaseId}`),candidate,releaseId,true);
 const finalAssets=await api(`${base}/releases/${releaseId}/assets?per_page=100`);
 assetSet(finalAssets,[...expected,{name:'verification.json',limit:2*65536}]);
 for(const asset of assets) {const final=finalAssets.find(item=>item.name===asset.name);assert.equal(final.id,asset.id);assert.equal(final.size,asset.size);assert.equal(final.digest,asset.digest);}
 confirmed(finalAssets.find(asset=>asset.name==='verification.json'),'verification.json',data);
 return result;
}
