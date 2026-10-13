import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=await fs.realpath(process.argv[2]), report=path.resolve(root,process.argv[3]);
assert(path.relative(root,report).startsWith('reports'+path.sep));
const sha=b=>createHash('sha256').update(b).digest('hex');
const rows=JSON.parse(await fs.readFile(path.join(report,'ui-downloads.json'),'utf8'));
const retained=path.join(report,'archives');
const results=[];
for(const row of rows){const p=await fs.realpath(row.path);assert(!path.relative(root,p).startsWith('..'));const bytes=await fs.readFile(p);const job=JSON.parse(await fs.readFile(path.join(report,'ui-job-'+row.format+'.json'),'utf8'));assert.equal(job.state,'succeeded');assert.equal(job.result.format,row.format);assert.equal(bytes.length,row.bytes);assert.equal(bytes.length,job.result.byte_size);assert.equal(sha(bytes),job.result.object_sha256);const to=path.join(retained,row.format+'.zip');await fs.writeFile(to,bytes,{flag:'wx'});results.push({format:row.format,sha256:sha(bytes),bytes:bytes.length,actual_UI_download_matches_real_job_SHA_and_size:true,network_body_capture_unavailable:true,retained:path.relative(root,to)});}
await fs.writeFile(path.join(report,'byte-preservation.json'),JSON.stringify({schema_version:1,status:'passed',model_calls:0,archives:results},null,2),{flag:'wx'});console.log(JSON.stringify(results));
