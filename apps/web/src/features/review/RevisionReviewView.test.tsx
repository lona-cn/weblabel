// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RevisionReviewView } from './RevisionReviewView';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
const revision: AnnotationRevision = { annotation_revision_id:'fixed-r', parent_revision_id:'before-r', revision_no:2, created_by:'annotator', created_at:'2026-10-13T00:00:00Z', content_hash:'hash', document:{ schema_version:1, asset_revision_id:'fixed-image', ontology_version_id:'fixed-ontology', coordinate_space:{type:'canonical_image_pixels',width:640,height:480}, completion:'complete', objects:Array.from({length:200},(_,index)=>({object_id:`object-${index}`,label_id:'label',geometry:{type:'bbox_xyxy',x_min:index,y_min:10,x_max:index+5,y_max:20},attributes:{},origin:{type:'manual',prediction_id:null,model_run_id:null,import_batch_id:null}})) } };
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('projects every object using fixed canonical media and ontology, with a virtual object list and full-image inspection', async ()=>{
  const urls:string[]=[];
  vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:canonical-review');
  vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(640);
  vi.stubGlobal('fetch',async(input:string|URL|Request)=>{
    const url=String(input);urls.push(url);
    if(url==='/api/assets/fixed-image/image') return new Response(new Blob(['fixture-image']),{status:200});
    if(url==='/api/projects/p/ontologies') return new Response(JSON.stringify({items:[{ontology_version_id:'new-ontology',project_id:'p',version_no:2,labels:[]},{ontology_version_id:'fixed-ontology',project_id:'p',version_no:1,labels:[{label_id:'label',name:'固定旧类别',color:'#00ff00',attributes:[],allowed_geometry_types:['bbox_xyxy'],shortcut:null}]}],next_cursor:null}),{status:200});
    throw new Error('unexpected mutable-head read '+url);
  });
  const parent={...revision,annotation_revision_id:'before-r',parent_revision_id:null,document:{...revision.document,objects:revision.document.objects.map(object=>object.object_id==='object-0'?{...object,geometry:{...object.geometry,x_min:0,x_max:30}}:object)}};
  const view=render(<RevisionReviewView projectId="p" revision={revision} parent={parent} issues={[{issue_id:'issue',review_id:'review',annotation_revision_id:'fixed-r',ontology_version_id:'fixed-ontology',object_id:'object-0',code:'geometry',message:'核查位置',region:null,created_at:'now'}]} />);
  await screen.findByRole('img',{name:'固定版本 fixed-r 的标注投影'});
  expect(view.container.querySelectorAll('rect[data-object-id]')).toHaveLength(200);
  expect(screen.getAllByRole('button',{name:/定位对象/}).length).toBeLessThan(200);
  expect(screen.getAllByRole('button',{name:/固定旧类别/}).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button',{name:'定位问题'}));
  expect(screen.getByRole('img').getAttribute('viewBox')).not.toBe('0 0 640 480');
  fireEvent.click(screen.getByRole('button',{name:'基线前版本'}));
  expect(screen.getByRole('img',{name:'固定版本 before-r 的标注投影'})).toBeInTheDocument();
  expect(view.container.querySelector('rect[data-object-id="object-0"]')?.getAttribute('width')).toBe('30');
  fireEvent.click(screen.getByRole('button',{name:'检查全图（含无变化区域）'}));
  expect(screen.getByRole('img').getAttribute('viewBox')).toBe('0 0 640 480');
  expect(urls).toEqual(['/api/assets/fixed-image/image','/api/projects/p/ontologies']);
  view.unmount();
  await waitFor(()=>expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:canonical-review'));
});
