import assert from 'node:assert/strict';
import { readFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { assertStorageApproval, assertSteps, writeBundle, verifyBundles } from './ci-contract.mjs';
import { publishCandidate } from './ci-publish.mjs';
const env=process.env;
const repository=env.GITHUB_REPOSITORY;
async function api(route,{method='GET',body,upload=false}={}) {
 const response=await fetch(`https://${upload?'uploads':'api'}.github.com${route}`,{
  method,headers:{Authorization:`Bearer ${env.GH_TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(body?{'Content-Type':upload?'application/octet-stream':'application/json'}:{})},
  body:body?(upload?body:JSON.stringify(body)):undefined,
 });
 if(response.status===404 && method==='GET')return null;
 assert.ok(response.ok,`GitHub ${method} ${route}: ${response.status}`);
 return response.status===204?null:response.json();
}
async function artifacts(route) {
 const result=[];
 for(let page=1;;page++) {
  const data=await api(`${route}?per_page=100&page=${page}`);
  assert.ok(data && Array.isArray(data.artifacts));result.push(...data.artifacts);
  if(data.artifacts.length<100)return result;
 }
}
const command=process.argv[2];
if(command==='steps') {
 assertSteps(JSON.parse(env.STEPS),env.REQUIRED.trim().split(/\s+/u));
} else if(command==='quota') {
 const items=await artifacts(`/repos/${repository}/actions/artifacts`);
 assertStorageApproval(JSON.parse(env.STORAGE_APPROVAL||'null'),items.reduce((sum,item)=>sum+item.size_in_bytes,0));
} else if(command==='bundle') {
 const version=JSON.parse(await readFile('package.json','utf8')).version;
 const platform=process.platform==='win32'?'windows':'linux';
 await mkdir('ci-bundle',{recursive:false});
 for(const name of await readdir('release')) {
  if(name.startsWith(`rele-${version}-${platform}-x64`) && /\.(deb|gz|exe|zip|sha256)$/.test(name))await copyFile(`release/${name}`,`ci-bundle/${name}`);
 }
 await writeBundle('ci-bundle',platform,version,env.GITHUB_SHA,env.GITHUB_RUN_ID,env.GITHUB_RUN_ATTEMPT);
} else if(command==='publish') {
 assert.equal(env.GITHUB_REF,'refs/heads/main');
 const version=JSON.parse(await readFile('package.json','utf8')).version;
 const bundle=await verifyBundles('incoming',version,env.GITHUB_SHA,env.GITHUB_RUN_ID,env.GITHUB_RUN_ATTEMPT);
 const items=await artifacts(`/repos/${repository}/actions/runs/${env.GITHUB_RUN_ID}/artifacts`);
 const selected=['Linux','Windows'].map(platform=>{
  const matches=items.filter(item=>item.name===`rele-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${platform}`);
  assert.equal(matches.length,1);assert.equal(matches[0].expired,false);return matches[0].id;
 });
 const release=await publishCandidate(api,bundle,repository,version,env.GITHUB_SHA,selected);
 console.log(`Draft release: ${release.html_url}`);
} else throw new Error('Unknown CI command');
