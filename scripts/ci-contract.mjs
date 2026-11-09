import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PLATFORM_LIMIT = 100 * 1024 ** 2;
export function assertStorageApproval(approval, currentBytes, now = Date.now()) {
 assert.ok(approval && approval.paidUsageBlocked === true, 'A verified zero-spend account budget is required');
 const age = now - Date.parse(approval.checkedAt);
 assert.ok(Number.isFinite(age) && age >= 0 && age <= 6 * 60 * 60 * 1000, 'Storage approval must be at most six hours old');
 assert.ok(Number.isSafeInteger(approval.freeBytes) && approval.freeBytes >= 2 * PLATFORM_LIMIT, 'Insufficient verified account-wide free storage');
 assert.ok(Number.isSafeInteger(currentBytes) && currentBytes >= 0 && currentBytes + 2 * PLATFORM_LIMIT <= 500 * 1024 ** 2, 'Repository artifacts exceed the conservative free allowance');
}
export function assertSteps(steps, required) {
 for (const id of required) assert.ok(steps[id]?.outcome === 'success' && steps[id]?.conclusion === 'success', `Required step ${id} did not pass`);
}
function names(platform, version) {
 assert.ok(['linux','windows'].includes(platform));
 assert.match(version, /^\d+\.\d+\.\d+-rc\.\d+$/u, 'Only immutable RC candidates are published by CI');
 const stem = `rele-${version}-${platform}-x64`;
 return (platform === 'linux' ? ['.deb','.tar.gz'] : ['-setup.exe','.zip']).flatMap(ext => [stem+ext,stem+ext+'.sha256']);
}
async function inventory(directory, platform, version) {
 const files=[];
 for (const name of names(platform,version)) {
  const file=path.join(directory,name), stat=await lstat(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= PLATFORM_LIMIT, 'Invalid package file');
  const data=await readFile(file);
  files.push({name,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
 }
 assert.ok(files.reduce((n,f)=>n+f.bytes,0) <= PLATFORM_LIMIT-65536, 'Platform bundle exceeds 100 MiB');
 for (const file of files.filter(f=>!f.name.endsWith('.sha256'))) {
  assert.equal((await readFile(path.join(directory,file.name+'.sha256'),'utf8')).trim(), `${file.sha256}  ${file.name}`, 'Package checksum sidecar mismatch');
 }
 return files;
}
export async function writeBundle(directory, platform, version, commit, runId, attempt) {
 assert.match(commit,/^[a-f0-9]{40}$/u);assert.match(runId,/^[1-9]\d*$/u);assert.match(attempt,/^[1-9]\d*$/u);
 assert.deepEqual((await readdir(directory)).sort(),names(platform,version).sort(), 'Unexpected transfer files');
 const evidence={platform,version,commit,runId,attempt,files:await inventory(directory,platform,version)};
 await writeFile(path.join(directory,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
 return evidence;
}
export async function verifyBundles(root, version, commit, runId, attempt) {
 assert.deepEqual((await readdir(root)).sort(),['linux','windows']);
 const files=[], evidence=[];
 for(const platform of ['linux','windows']) {
  const directory=path.join(root,platform), stat=await lstat(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  assert.deepEqual((await readdir(directory)).sort(),[...names(platform,version),'evidence.json'].sort());
  const meta=await lstat(path.join(directory,'evidence.json'));assert.ok(meta.isFile() && !meta.isSymbolicLink() && meta.size <= 65536);
  const actual=await inventory(directory,platform,version);
  const report=JSON.parse(await readFile(path.join(directory,'evidence.json'),'utf8'));
  assert.deepEqual(report,{platform,version,commit,runId,attempt,files:actual}, 'Bundle provenance or content mismatch');
  files.push(...actual.map(f=>({...f,path:path.join(directory,f.name)})));evidence.push(report);
 }
 return {files,evidence};
}
