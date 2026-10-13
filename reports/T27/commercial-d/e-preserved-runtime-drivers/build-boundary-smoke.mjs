import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {buildRelease} from '../../../scripts/build.mjs';
const root=await fs.realpath(process.cwd());const parent=path.join(root,'target/build-cache/commercial-d');
const scratch=await fs.mkdtemp(path.join(parent,'build-boundary-'));const cases=[];
const existing=path.join(scratch,'existing');await fs.mkdir(existing);await fs.writeFile(path.join(existing,'sentinel'),'owned-sentinel');
const existingFile=path.join(scratch,'existing-file');await fs.writeFile(existingFile,'owned-file');
async function rejected(name,output,intermediate,code){await assert.rejects(()=>buildRelease(['--build-dir',output,'--intermediate-dir',intermediate]),error=>error.message.startsWith(code));assert.equal(await fs.readFile(path.join(existing,'sentinel'),'utf8'),'owned-sentinel');assert.equal(await fs.readFile(existingFile,'utf8'),'owned-file');await assert.rejects(()=>fs.lstat(output),error=>error.code==='ENOENT');cases.push({name,rejected:true,sentinel_unchanged:true,no_release_output:true});}
await rejected('existing intermediate directory',path.join(scratch,'release-one'),existing,'intermediate_directory_exists');
await rejected('existing intermediate file',path.join(scratch,'release-two'),existingFile,'intermediate_directory_exists');
const same=path.join(scratch,'same');await rejected('equal future paths',same,same,'build_directories_overlap');
const nested=path.join(scratch,'nested');await rejected('intermediate inside release',nested,path.join(nested,'intermediate'),'build_directories_overlap');
const reverse=path.join(scratch,'reverse');await rejected('release inside intermediate',path.join(reverse,'release'),reverse,'build_directories_overlap');
if(process.platform==='win32'){const alias=path.join(scratch,'CaseAlias');await rejected('Windows case alias',alias,alias.toUpperCase(),'build_directories_overlap');}
await fs.writeFile('reports/T27/commercial-d/d5-build-boundary-observation.json',JSON.stringify({actual_node:process.version,cases,limit:'Real buildRelease preflight/unchanged sentinels only; full successful API/WASM/web/Host build and physical junction branch still mandatory or separately exercised.'},null,2)+'\n');
console.log(JSON.stringify({cases:cases.length,all_rejected_without_release:true}));await fs.rm(scratch,{recursive:true});
