import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root=fs.realpathSync(process.cwd());
const base="289e41291ea8303f13514050eb34a71c9f42dbe0";
const slices=[['draft-branches','apps/web/src/features/workbench/Workbench.tsx'],['detector-lifecycle','apps/agent-host/src/providers/detector-local.ts'],['yolo-precision','crates/dataset-formats/src/yolo.rs']];
const records=[];
for(const [name,sample] of slices){const checkout=fs.realpathSync(path.join(root,'target/worktrees',name));assert.ok(checkout.startsWith(root+path.sep));const head=execFileSync('git',['rev-parse','HEAD'],{cwd:checkout,encoding:'utf8'}).trim();assert.equal(head,base);const original=fs.statSync(path.join(root,sample),{bigint:true});const isolated=fs.statSync(path.join(checkout,sample),{bigint:true});assert.notEqual(original.ino,isolated.ino);const marker='__isolation_'+randomUUID();const markerPath=path.join(checkout,marker);fs.writeFileSync(markerPath,name,{flag:'wx'});assert.equal(fs.existsSync(path.join(root,marker)),false);fs.unlinkSync(markerPath);records.push({slice:name,repository:root,checkout,head,purpose:name,source_sample:sample,original_inode:original.ino.toString(),isolated_inode:isolated.ino.toString(),private_marker_verified:true,actual_realpath_in_project:true});}
fs.writeFileSync("reports/T35/defect-repair/2026-10-11T13-21-39-234Z/worktrees-isolation.json",JSON.stringify({schema_version:1,permanent_project_root:root,records},null,2));console.log(JSON.stringify(records));
