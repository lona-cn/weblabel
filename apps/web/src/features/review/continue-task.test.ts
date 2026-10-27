import { describe, expect, it } from 'vitest';
import type { ReviewTask, TaskSubmission } from './api';
import { nextAssignedTask } from './continue-task';
const task = (id: string, assignee = 'actor', state = 'open'): ReviewTask => ({ task_id:id, project_id:'project', asset_revision_id:'asset-'+id, ontology_version_id:'ontology', assignee_id:assignee, state, created_at:'2026-10-13T00:00:00Z', review_id:null, revision_ids:null, review_decision:null, review_reason:null });
const current = task('current');
const submission: TaskSubmission = { review_id:'review', task_id:current.task_id, submitted_by:'actor', revision_ids:['revision'], state:'pending', created_at:'2026-10-13T00:00:00Z', lease_ended:true };
const session = { user_id:'actor', username:'annotator', platform_admin:false, project_roles:[{project_id:'project',role:'annotator'}] };
describe('safe read-only task continuation', () => {
  it('finds the next own open task beyond a full page of ineligible tasks', async () => {
    const next = task('next');
    const value = await nextAssignedTask({task:current,submission,actorId:'actor',projectId:'project',isCurrent:()=>true,read:{session:async()=>session,submission:async()=>submission,tasks:async(_project,cursor)=> cursor ? {items:[task('closed','actor','closed'),next],next_cursor:null} : {items:Array.from({length:100},(_,i)=>task('foreign-'+i,'someone-else')),next_cursor:'page-2'}}});
    expect(value?.task_id).toBe('next');
  });
  it('does not adopt a submission with the same revision but a different actor or review', async () => {
    for(const wrong of [{...submission,submitted_by:'other'},{...submission,review_id:'other'},{...submission,lease_ended:false},{...submission,state:'rejected'}]) {
      await expect(nextAssignedTask({task:current,submission,actorId:'actor',projectId:'project',isCurrent:()=>true,read:{session:async()=>session,submission:async()=>wrong,tasks:async()=>({items:[task('next')],next_cursor:null})}})).rejects.toThrow();
    }
  });
  it('refuses a late page after the local save or identity fence has changed', async () => {
    let currentScope = true;
    await expect(nextAssignedTask({task:current,submission,actorId:'actor',projectId:'project',isCurrent:()=>currentScope,read:{session:async()=>session,submission:async()=>submission,tasks:async()=>{currentScope=false;return{items:[task('next')],next_cursor:null};}}})).rejects.toThrow();
  });
  it('cannot continue after actual project membership is revoked', async () => {
    await expect(nextAssignedTask({task:current,submission,actorId:'actor',projectId:'project',isCurrent:()=>true,read:{session:async()=>({...session,project_roles:[]}),submission:async()=>submission,tasks:async()=>({items:[task('next')],next_cursor:null})}})).rejects.toThrow();
  });
});
