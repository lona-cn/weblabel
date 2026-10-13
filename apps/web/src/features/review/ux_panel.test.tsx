// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReviewPanel, type TaskOpenPreparation } from './ReviewPanel';
import type { ReviewTask } from './api';
const task: ReviewTask = { task_id:'t', project_id:'p', asset_revision_id:'image', ontology_version_id:'fixed', assignee_id:'a', state:'open', created_at:'2026-10-13', review_id:null, revision_ids:null, review_decision:null, review_reason:null };
const session = { user_id:'a', username:'a', platform_admin:false, project_roles:[{project_id:'p', role:'annotator'}] };
const prepare = async (): Promise<TaskOpenPreparation> => ({ token:Symbol(), isCurrent:()=>true, validateCurrent:async()=>true, onTaskOpen:()=>{}, release:()=>{} });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function transport(unknown = false) {
  const calls: { url:string; method:string; body:unknown }[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?:RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({url, method, body});
    if (url.endsWith('/submit') && unknown) throw new TypeError('lost acknowledgement');
    const value = url.includes('/tasks?') ? {items:[task],next_cursor:null} : url.endsWith('/lease') ? {task_id:url.split('/').at(-2),holder_id:'a',fencing_token:4,expires_at_unix:1900000000,heartbeat_seconds:20,lease_seconds:60} : {review_id:'review',task_id:'t',submitted_by:'a',revision_ids:['r'],state:'pending',created_at:'2026-10-13',lease_ended:true};
    return new Response(JSON.stringify(value), {status:200,headers:{'content-type':'application/json'}});
  });
  vi.stubGlobal('fetch', fetcher);
  return calls;
}
it('does not POST release on unmount after an unknown submission', async () => {
  const calls = transport(true);
  const view = render(<ReviewPanel projectId="p" session={session} onPrepareTaskCreate={prepare} onPrepareTaskOpen={prepare} onLeaseChange={()=>{}} onSubmitTask={async (_task, submit)=>submit('r')} />);
  fireEvent.click(await screen.findByRole('button',{name:'领取任务'}));
  await waitFor(()=>expect(screen.getByTestId('task-submit')).not.toBeDisabled());
  fireEvent.click(screen.getByTestId('task-submit'));
  await screen.findByRole('button',{name:'只读核对提交'});
  view.unmount();
  expect(calls.filter(call=>call.url.endsWith('/lease') && call.body && typeof call.body === 'object' && 'action' in call.body && call.body.action === 'release')).toHaveLength(0);
});
it('readback allows guarded continue but never resends the unknown POST', async () => {
  const calls = transport(true), continueTask = vi.fn(async ()=>null), leaseChange = vi.fn();
  render(<ReviewPanel projectId="p" session={session} onPrepareTaskCreate={prepare} onPrepareTaskOpen={prepare} onLeaseChange={leaseChange} onSubmitTask={async (_task, submit)=>submit('r')} onContinueTask={continueTask} />);
  fireEvent.click(await screen.findByRole('button',{name:'领取任务'}));
  await waitFor(()=>expect(screen.getByTestId('task-submit')).not.toBeDisabled());
  fireEvent.click(screen.getByTestId('task-submit'));
  fireEvent.click(await screen.findByRole('button',{name:'只读核对提交'}));
  fireEvent.click(await screen.findByRole('button',{name:'完成并继续'}));
  await waitFor(()=>expect(continueTask).toHaveBeenCalledTimes(1));
  expect(calls.filter(call=>call.url.endsWith('/submit'))).toHaveLength(1);
  expect(calls.filter(call=>call.url.endsWith('/submission'))[0]?.method).toBe('GET');
  expect(leaseChange).toHaveBeenLastCalledWith(null);
});
it('success ends the local lease using the server acknowledgement, without a release POST', async () => {
  const calls = transport(), leaseChange = vi.fn();
  const view = render(<ReviewPanel projectId="p" session={session} onPrepareTaskCreate={prepare} onPrepareTaskOpen={prepare} onLeaseChange={leaseChange} onSubmitTask={async (_task, submit)=>submit('r')} onContinueTask={async()=>null} />);
  fireEvent.click(await screen.findByRole('button',{name:'领取任务'}));
  await waitFor(()=>expect(screen.getByTestId('task-submit')).not.toBeDisabled());
  fireEvent.click(screen.getByTestId('task-submit'));
  await screen.findByRole('button',{name:'完成并继续'});
  expect(leaseChange).toHaveBeenLastCalledWith(null);
  view.unmount();
  expect(calls.filter(call=>call.url.endsWith('/lease') && call.body && typeof call.body === 'object' && 'action' in call.body && call.body.action==='release')).toHaveLength(0);
});
it('rejects mismatched readback actor and retains the exact unknown target', async () => {
  const calls = transport(true), original = fetch;
  vi.stubGlobal('fetch',async(input:string|URL|Request, init?:RequestInit)=>String(input).endsWith('/submission') ? new Response(JSON.stringify({task_id:'t',submitted_by:'other',revision_ids:['r'],state:'pending',lease_ended:true}),{status:200}) : original(input,init));
  render(<ReviewPanel projectId="p" session={session} onPrepareTaskCreate={prepare} onPrepareTaskOpen={prepare} onLeaseChange={()=>{}} onSubmitTask={async (_task, submit)=>submit('r')} onContinueTask={async()=>null} />);
  fireEvent.click(await screen.findByRole('button',{name:'领取任务'}));
  await waitFor(()=>expect(screen.getByTestId('task-submit')).not.toBeDisabled());
  fireEvent.click(screen.getByTestId('task-submit'));
  fireEvent.click(await screen.findByRole('button',{name:'只读核对提交'}));
  await screen.findByText(/尚未确认同一身份、固定版本和租约终结/,{selector:'p'});
  expect(screen.queryByRole('button',{name:'完成并继续'})).toBeNull();
  expect(screen.getByTestId('task-submit')).toBeDisabled();
  expect(calls.filter(call=>call.url.endsWith('/submit'))).toHaveLength(1);
});
it('explains a definite refusal separately from an unknown outcome', async () => {
  transport(); const original = fetch;
  vi.stubGlobal('fetch',async(input:string|URL|Request,init?:RequestInit)=>String(input).endsWith('/submit') ? new Response(JSON.stringify({code:'REVISION_MISMATCH',message:'fixed revision mismatch'}),{status:422}) : original(input,init));
  render(<ReviewPanel projectId="p" session={session} onPrepareTaskCreate={prepare} onPrepareTaskOpen={prepare} onLeaseChange={()=>{}} onSubmitTask={async (_task, submit)=>submit('r')} />);
  fireEvent.click(await screen.findByRole('button',{name:'领取任务'}));
  await waitFor(()=>expect(screen.getByTestId('task-submit')).not.toBeDisabled());
  fireEvent.click(screen.getByTestId('task-submit'));
  await screen.findByText(/提交被明确拒绝/,{selector:'p'});
  expect(screen.queryByRole('button',{name:'只读核对提交'})).toBeNull();
});
it('keeps confirmed submission after a refresh failure and never suggests resending', async () => {
  const calls = transport(), original = fetch; let written = false;
  vi.stubGlobal('fetch',async(input:string|URL|Request,init?:RequestInit)=>{
    if(String(input).endsWith('/submit')) written=true;
    if(written && String(input).includes('/tasks?')) throw new Error('read unavailable');
    return original(input,init);
  });
  render(<ReviewPanel projectId="p" session={session} onPrepareTaskCreate={prepare} onPrepareTaskOpen={prepare} onLeaseChange={()=>{}} onSubmitTask={async (_task, submit)=>submit('r')} onContinueTask={async()=>null} />);
  fireEvent.click(await screen.findByRole('button',{name:'领取任务'}));
  await waitFor(()=>expect(screen.getByTestId('task-submit')).not.toBeDisabled());
  fireEvent.click(screen.getByTestId('task-submit'));
  await screen.findByText(/写入已成功，但读取刷新失败；不要重发操作/,{selector:'p'});
  expect(screen.getByRole('button',{name:'完成并继续'})).toBeInTheDocument();
  expect(calls.filter(call=>call.url.endsWith('/submit'))).toHaveLength(1);
});
it('loads remaining task pages and clearly scopes filter counts to loaded tasks', async () => {
  const calls = transport(), original = fetch;
  vi.stubGlobal('fetch',async(input:string|URL|Request,init?:RequestInit)=>{
    const url=String(input);
    if(url.includes('/tasks?')) return new Response(JSON.stringify(url.includes('cursor=page-two') ? {items:[{...task,task_id:'last',state:'submitted'}],next_cursor:null} : {items:[task],next_cursor:'page-two'}),{status:200});
    return original(input,init);
  });
  render(<ReviewPanel projectId="p" session={session} onPrepareTaskCreate={prepare} onPrepareTaskOpen={prepare} onLeaseChange={()=>{}} onSubmitTask={async (_task, submit)=>submit('r')} />);
  await screen.findByText(/计数仅限已加载任务/);
  fireEvent.click(screen.getByRole('button',{name:'继续读取任务'}));
  await screen.findByTestId('review-task-last');
  fireEvent.change(screen.getByRole('combobox',{name:'任务队列'}),{target:{value:'pending'}});
  expect(screen.queryByTestId('review-task-t')).toBeNull();
  expect(screen.getByTestId('review-task-last')).toBeInTheDocument();
  expect(screen.getByText(/已读取全部分页（读取时点，非全站统计）/)).toBeInTheDocument();
  expect(calls).toHaveLength(0);
});
it('continues through the existing task-open barrier and installs the next real lease', async () => {
  const calls=transport(), leaseChange=vi.fn(), opened=vi.fn();
  const next={...task,task_id:'next',asset_revision_id:'next-image'};
  const prepareOpen=vi.fn(async ():Promise<TaskOpenPreparation>=>({...await prepare(),onTaskOpen:opened}));
  const proof={isCurrent:()=>true};
  render(<ReviewPanel projectId="p" session={session} onPrepareTaskCreate={prepare} onPrepareTaskOpen={prepareOpen} onLeaseChange={leaseChange} onSubmitTask={async (_task, submit)=>submit('r')} onContinueTask={async input=>input.isCurrent()?{task:next,proof}:null} />);
  fireEvent.click(await screen.findByRole('button',{name:'领取任务'}));
  await waitFor(()=>expect(screen.getByTestId('task-submit')).not.toBeDisabled());
  fireEvent.click(screen.getByTestId('task-submit'));
  fireEvent.click(await screen.findByRole('button',{name:'完成并继续'}));
  await waitFor(()=>expect(opened).toHaveBeenCalledTimes(2));
  expect(prepareOpen).toHaveBeenLastCalledWith(next,proof);
  expect(leaseChange).toHaveBeenLastCalledWith({task_id:'next',asset_revision_id:'next-image',ontology_version_id:'fixed',fencing_token:4});
  expect(calls.filter(call=>call.url.endsWith('/lease') && call.body && typeof call.body==='object' && 'action' in call.body && call.body.action==='release')).toHaveLength(0);
});
it('a refused next-task preparation leaves the completed task context and receipt available', async () => {
  const calls=transport(), opened=vi.fn(); let count=0;
  const prepareOpen=async ():Promise<TaskOpenPreparation>=>({...await prepare(),validateCurrent:async()=>++count<=3,onTaskOpen:opened});
  render(<ReviewPanel projectId="p" session={session} onPrepareTaskCreate={prepare} onPrepareTaskOpen={prepareOpen} onLeaseChange={()=>{}} onSubmitTask={async (_task, submit)=>submit('r')} onContinueTask={async()=>({task:{...task,task_id:'next'},proof:{isCurrent:()=>true}})} />);
  fireEvent.click(await screen.findByRole('button',{name:'领取任务'}));
  await waitFor(()=>expect(screen.getByTestId('task-submit')).not.toBeDisabled());
  fireEvent.click(screen.getByTestId('task-submit'));
  fireEvent.click(await screen.findByRole('button',{name:'完成并继续'}));
  await screen.findByText(/下一任务未领取/,{selector:'p'});
  expect(opened).toHaveBeenCalledTimes(1);
  expect(calls.filter(call=>call.url==='/api/tasks/next/lease')).toHaveLength(0);
  expect(screen.getByRole('button',{name:'完成并继续'})).toBeInTheDocument();
});
it('unknown release retains its original target and does not renew, submit or resend on unmount', async () => {
  const calls=transport(), original=fetch;
  vi.stubGlobal('fetch',async(input:string|URL|Request,init?:RequestInit)=>{
    const body=typeof init?.body==='string'?JSON.parse(init.body):null;
    if(String(input).endsWith('/lease') && body?.action==='release') { calls.push({url:String(input),method:init?.method??'GET',body}); throw new TypeError('lost release response'); }
    return original(input,init);
  });
  const view=render(<ReviewPanel projectId="p" session={session} onPrepareTaskCreate={prepare} onPrepareTaskOpen={prepare} onLeaseChange={()=>{}} onSubmitTask={async (_task,submit)=>submit('r')} />);
  fireEvent.click(await screen.findByRole('button',{name:'领取任务'}));
  await waitFor(()=>expect(screen.getByTestId('task-submit')).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button',{name:'释放当前任务'}));
  await screen.findByRole('button',{name:'只读核对租约相关任务'});
  expect(screen.getByTestId('task-submit')).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'只读核对租约相关任务'}));
  view.unmount();
  expect(calls.filter(call=>call.url.endsWith('/lease') && call.body && typeof call.body==='object' && 'action' in call.body && call.body.action==='release')).toHaveLength(1);
});
it('never acquires the resolver candidate after actor scope changes', async () => {
  const calls=transport(); let resolveNext:(task:import('./ReviewPanel').TaskContinueResult|null)=>void=()=>{throw new Error('resolver not dispatched');};
  const resolver=vi.fn(()=>new Promise<import('./ReviewPanel').TaskContinueResult|null>(resolve=>{resolveNext=resolve;}));
  const props={projectId:'p',session,onPrepareTaskCreate:prepare,onPrepareTaskOpen:prepare,onLeaseChange:()=>{},onSubmitTask:async(_task:ReviewTask,submit:(id:string)=>Promise<void>)=>submit('r'),onContinueTask:resolver};
  const view=render(<ReviewPanel {...props} />);
  fireEvent.click(await screen.findByRole('button',{name:'领取任务'}));
  await waitFor(()=>expect(screen.getByTestId('task-submit')).not.toBeDisabled());
  fireEvent.click(screen.getByTestId('task-submit'));
  fireEvent.click(await screen.findByRole('button',{name:'完成并继续'}));
  await waitFor(()=>expect(resolver).toHaveBeenCalledTimes(1));
  view.rerender(<ReviewPanel {...props} session={{...session,user_id:'b'}} />);
  resolveNext({task:{...task,task_id:'next'},proof:{isCurrent:()=>true}});
  await waitFor(()=>expect(screen.queryByRole('button',{name:'完成并继续'})).toBeNull());
  expect(calls.filter(call=>call.url==='/api/tasks/next/lease')).toHaveLength(0);
});
