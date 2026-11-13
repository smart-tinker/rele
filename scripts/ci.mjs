import assert from 'node:assert/strict';
import { readFile, mkdir, copyFile, readdir, appendFile } from 'node:fs/promises';
import { assertSteps, writeBundle, verifyBundles } from './ci-contract.mjs';
import { prepareCandidate, uploadPlatform, downloadCandidate, publishCandidate } from './ci-publish.mjs';
const env=process.env;
const repository=env.GITHUB_REPOSITORY;
async function api(route,{method='GET',body,upload=false,download=false}={}) {
 const response=await fetch(`https://${upload?'uploads':'api'}.github.com${route}`,{
  method,headers:{Authorization:`Bearer ${env.GH_TOKEN}`,Accept:download?'application/octet-stream':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(body?{'Content-Type':upload?'application/octet-stream':'application/json'}:{})},
  body:body?(upload?body:JSON.stringify(body)):undefined,
 });
 if(response.status===404 && method==='GET' && !download)return null;
 assert.ok(response.ok,`GitHub ${method} ${route}: ${response.status}`);
 return response.status===204?null:download?Buffer.from(await response.arrayBuffer()):response.json();
}
const command=process.argv[2];
if(command==='steps') {
 assertSteps(JSON.parse(env.STEPS),env.REQUIRED.trim().split(/\s+/u));
} else {
 const version=JSON.parse(await readFile('package.json','utf8')).version;
 const candidate={repository,version,commit:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT};
 const platform=process.platform==='win32'?'windows':'linux';
 if(command==='bundle') {
  await mkdir('ci-bundle',{recursive:false});
  for(const name of await readdir('release')) {
   if(name.startsWith(`rele-${version}-${platform}-x64`) && /\.(deb|gz|exe|zip|sha256)$/.test(name))await copyFile(`release/${name}`,`ci-bundle/${name}`);
  }
  await writeBundle('ci-bundle',platform,version,env.GITHUB_SHA,env.GITHUB_RUN_ID,env.GITHUB_RUN_ATTEMPT);
 } else {
  assert.equal(env.GITHUB_REF,'refs/heads/main');
  if(command==='prepare') {
   const release=await prepareCandidate(api,candidate);
   assert.ok(env.GITHUB_OUTPUT);await appendFile(env.GITHUB_OUTPUT,`release_id=${release.id}\n`);
  } else {
   const releaseId=Number(env.RELEASE_ID);
   if(command==='upload')await uploadPlatform(api,candidate,releaseId,'ci-bundle',platform);
   else if(command==='download')await downloadCandidate(api,candidate,releaseId,'incoming');
   else if(command==='publish') {
    const bundle=await verifyBundles('incoming',version,env.GITHUB_SHA,env.GITHUB_RUN_ID,env.GITHUB_RUN_ATTEMPT);
    const release=await publishCandidate(api,bundle,candidate,releaseId);
    console.log(`Verified draft release: ${release.html_url}`);
   } else throw new Error('Unknown CI command');
  }
 }
}
