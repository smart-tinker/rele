import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function publishCandidate(api, bundle, repository, version, commit, artifactIds) {
 assert.match(repository,/^[\w.-]+\/[\w.-]+$/u);
 assert.match(version,/^\d+\.\d+\.\d+-rc\.\d+$/u);assert.match(commit,/^[a-f0-9]{40}$/u);
 assert.equal(bundle.files.length,8);assert.equal(bundle.evidence.length,2);
 assert.equal(artifactIds.length,2);assert.ok(artifactIds.every(id => Number.isSafeInteger(id) && id > 0));assert.equal(new Set(artifactIds).size,2);
 const base=`/repos/${repository}`, tag=`v${version}`;
 assert.equal((await api(`${base}/git/ref/heads/main`)).object.sha,commit,'Main advanced; verify a new candidate');
 assert.equal(await api(`${base}/git/ref/tags/${tag}`),null,'Tag already exists; never overwrite an RC');
 assert.equal(await api(`${base}/releases/tags/${tag}`),null,'Release already exists; reconcile before retry');
 const files=[];
 for(const file of bundle.files) {
  const body=await readFile(file.path);
  assert.equal(body.length,file.bytes);assert.equal(createHash('sha256').update(body).digest('hex'),file.sha256);
  files.push({name:file.name,body});
 }
 files.push({name:'verification.json',body:Buffer.from(JSON.stringify(bundle.evidence,null,2)+'\n')});
 const release=await api(`${base}/releases`,{method:'POST',body:{tag_name:tag,target_commitish:commit,name:`Rele ${version}`,draft:true,prerelease:true,body:`Verified Windows/Linux candidate at ${commit}. Real Desktop and messenger acceptance is still required.`}});
 assert.ok(Number.isSafeInteger(release.id));
 for(const file of files) {
  const asset=await api(`${base}/releases/${release.id}/assets?name=${encodeURIComponent(file.name)}`,{method:'POST',body:file.body,upload:true});
  assert.equal(asset.name,file.name);assert.equal(asset.size,file.body.length);
  assert.equal(asset.digest,'sha256:'+createHash('sha256').update(file.body).digest('hex'),'Uploaded bytes were not confirmed');
 }
 // Only the two artifacts admitted from this exact run/attempt; old backups stay untouched.
 for(const id of artifactIds)await api(`${base}/actions/artifacts/${id}`,{method:'DELETE'});
 return release;
}
