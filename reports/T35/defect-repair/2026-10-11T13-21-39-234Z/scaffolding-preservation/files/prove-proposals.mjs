import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=fs.realpathSync(process.cwd()), base="289e41291ea8303f13514050eb34a71c9f42dbe0";
const records=[];
for(const [name,sample] of [['live-evidence-proposal','scripts/verify-live.mjs'],['gpu-runner-proposal','scripts/verify-gpu.mjs']]) {
 const checkout=fs.realpathSync(path.join(root,'target/worktrees',name)); assert.ok(checkout.startsWith(root+path.sep));
 const head=execFileSync('git',['rev-parse','HEAD'],{cwd:checkout,encoding:'utf8'}).trim(); assert.equal(head,base);
 const a=fs.statSync(path.join(root,sample),{bigint:true}), b=fs.statSync(path.join(checkout,sample),{bigint:true}); assert.notEqual(a.ino,b.ino);
 const marker='__isolation_'+randomUUID(); fs.writeFileSync(path.join(checkout,marker),name,{flag:'wx'}); assert.equal(fs.existsSync(path.join(root,marker)),false); fs.unlinkSync(path.join(checkout,marker));
 records.push({repository:root,checkout,head,purpose:'Report-only code proposal '+name,source_sample:sample,original_inode:String(a.ino),isolated_inode:String(b.ino),private_marker_visible_in_main:false});
}
fs.writeFileSync("reports/T35/defect-repair/2026-10-11T13-21-39-234Z/proposal-worktrees-isolation.json",JSON.stringify({schema_version:1,permanent_project_root:root,records},null,2),{flag:'wx'}); console.log(JSON.stringify(records));
