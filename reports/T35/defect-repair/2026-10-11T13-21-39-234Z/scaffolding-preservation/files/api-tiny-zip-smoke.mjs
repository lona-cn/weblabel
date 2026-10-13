import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { start_test_app, download_for_test } from 'file:///D:/workspace/src/weblabel/tests/support/app.ts';
import { createDeliveryFixture, freezeDelivery, exportAndVerifyDelivery, pollDeliveryJob } from 'file:///D:/workspace/src/weblabel/tests/support/dataset-delivery.ts';
import { captureEvidenceIdentity } from 'file:///D:/workspace/src/weblabel/scripts/evidence-identity.mjs';
const root="D:/workspace/src/weblabel", report=path.join(root,"reports/T35/defect-repair/2026-10-11T13-21-39-234Z/api-tiny-zip"); fs.mkdirSync(report,{recursive:true});
const identity=captureEvidenceIdentity(); const app=await start_test_app('false','manual');
const evidence={schema_version:1,evidence_kind:'actual_loopback_API_three_format_ZIP_smoke_not_browser_or_model',identity,status:'failed',model_calls:0,archives:[],cleanup:null};
async function api(client,method,url,body){const response=await client.request(method,url,body);assert.equal(response.status,200,JSON.stringify(response.json));return response.json;}
try {
 const fixture=await createDeliveryFixture(app,3,1), item=fixture.assets[1], oldRevision=item.revision.annotation_revision_id, oldReview=item.review.review_id;
 const document=structuredClone(item.revision.document), size=1e-307; document.objects[0].geometry={type:'bbox_xyxy',x_min:0,y_min:0,x_max:size,y_max:size};
 const task=await api(fixture.admin,'POST','/api/projects/'+fixture.projectId+'/tasks',{asset_revision_id:item.media.asset_revision_id,ontology_version_id:fixture.ontologyId,assignee_id:fixture.annotatorId});
 const acquired=await api(fixture.annotator,'POST','/api/tasks/'+task.task_id+'/lease',{action:'acquire'});
 const saved=await api(fixture.annotator,'PUT','/api/assets/'+item.media.asset_revision_id+'/annotation',{operation_id:randomUUID(),base_revision_id:oldRevision,document,lease:{task_id:task.task_id,fencing_token:acquired.fencing_token},suggestion_decisions:[]});
 item.revision=await api(fixture.admin,'GET','/api/annotation-revisions/'+saved.revision.annotation_revision_id);assert.deepEqual(item.revision.document,document);assert.equal(item.revision.parent_revision_id,oldRevision);
 const submitted=await api(fixture.annotator,'POST','/api/tasks/'+task.task_id+'/submit',{annotation_revision_ids:[item.revision.annotation_revision_id]});
 item.review=await api(fixture.reviewer,'POST','/api/reviews/'+submitted.review_id+'/decision',{decision:'approve',reason:'Independent tiny f64 API smoke',revision_ids:[item.revision.annotation_revision_id]});assert.notEqual(item.review.review_id,oldReview);assert.deepEqual(item.review.revision_ids,[item.revision.annotation_revision_id]);
 const frozen=await freezeDelivery(fixture,[0,1,2]);fs.writeFileSync(path.join(report,'expected.json'),JSON.stringify({datasetId:frozen.datasetId,projectId:fixture.projectId,ontology:fixture.ontology,snapshotHash:frozen.snapshotHash,expected:frozen.expected,excluded:frozen.excluded},null,2));
 for(const format of ['native','yolo','coco']){const receipt=await exportAndVerifyDelivery(frozen,format);const result=await pollDeliveryJob(fixture.admin,receipt.jobId);const download=await download_for_test(fixture.admin,result.download_url);assert.equal(download.status,200);assert.equal(createHash('sha256').update(download.bytes).digest('hex'),receipt.archiveSha256);fs.writeFileSync(path.join(report,format+'.zip'),download.bytes);evidence.archives.push({...receipt,result,retained_archive:"reports/T35/defect-repair/2026-10-11T13-21-39-234Z/api-tiny-zip/"+format+'.zip'});}
 const parser=path.join(root,"target/defect-repair/2026-10-11T13-21-39-234Z/tiny-yolo-oracle.py");evidence.tiny=JSON.parse(execFileSync(process.env.PYTHON??'python',[parser,path.join(report,'yolo.zip'),path.join(report,'expected.json')],{encoding:'utf8'}));evidence.status='passed';evidence.snapshot={dataset_id:frozen.datasetId,snapshot_sha256:frozen.snapshotHash,old_revision:oldRevision,new_revision:item.revision.annotation_revision_id,old_review:oldReview,new_review:item.review.review_id};
} catch(error){evidence.error={name:error.name,message:error.message,stack:error.stack};throw error;}
finally {try{await app.stop();evidence.cleanup='owned TestApp stop completed';}finally{fs.writeFileSync(path.join(report,'result.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({status:evidence.status,archives:evidence.archives,tiny:evidence.tiny,cleanup:evidence.cleanup,model_calls:0},null,2));}}
