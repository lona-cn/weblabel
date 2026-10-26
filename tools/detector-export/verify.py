"""Measured Python vs real Rust worker. No automatic retries, warmups or relaxed bounds."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import math
import hashlib
import os
from pathlib import Path
import subprocess
import traceback
from budget import Ledger,meter_model
from common import FIXED_ROOT,SOURCE,confined,digest,identity,offline,weights,new_directory,load_model,graph

MAX_FRAME=4*1024*1024
RUNTIME=FIXED_ROOT/'target/tools/onnxruntime-1.23.2/onnxruntime-win-x64-1.23.2/lib/onnxruntime.dll'
RUNTIME_SHA='dec964ab1ee36cc9b0ae247d13b376627992fc57dec0454354017ab8fd84f1ea'


def invoke(binary,request,method='start_run'):
    encoded=(json.dumps({'protocol_version':1,'id':request['run_id'],'kind':'request','method':method,'payload':request},allow_nan=False,separators=(',',':'))+'\n').encode()
    if len(encoded)>MAX_FRAME: raise RuntimeError('request frame too large')
    env={k:v for k,v in os.environ.items() if k in ('SystemRoot','WINDIR')}
    env.update({k:request['artifact_root'] for k in ('TEMP','TMP','TMPDIR')})
    process=subprocess.Popen([str(binary),'detector-worker'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,cwd=request['artifact_root'],env=env)
    def kill():
        if os.name=='nt':
            executable=Path(os.environ.get('SystemRoot','C:/Windows'))/'System32/taskkill.exe'
            subprocess.run([str(executable),'/PID',str(process.pid),'/T','/F'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10,check=False)
        else: process.kill()
    def read(stream,limit):
        data=stream.read(limit+1)
        if len(data)>limit:
            kill()
            raise RuntimeError('worker output budget exceeded')
        return data
    with ThreadPoolExecutor(max_workers=2) as executor:
        stdout=executor.submit(read,process.stdout,MAX_FRAME+2)
        stderr=executor.submit(read,process.stderr,64*1024)
        try:
            process.stdin.write(encoded);process.stdin.close()
            process.wait(timeout=request['timeout_ms']/1000)
            out=stdout.result(timeout=5);err=stderr.result(timeout=5)
        except BaseException:
            kill();process.wait(timeout=10)
            raise
        finally:
            process.stdout.close();process.stderr.close()
    if process.returncode!=0: raise RuntimeError(f'native worker exit {process.returncode}; stderr length={len(err)}')
    if not out.endswith(b'\n') or len(out.splitlines())!=1: raise RuntimeError('worker framing violation')
    response=json.loads(out)
    if response.get('protocol_version')!=1 or response.get('id')!=request['run_id'] or response.get('kind')!='response' or response.get('method')!=method: raise RuntimeError('worker response identity mismatch')
    if 'error' in response['payload']: raise RuntimeError(f'worker controlled error: {response["payload"]["error"]}')
    return response['payload']['result']


def reference(logits,boxes,id2label,mapping,p):
    # Independent reference of pinned per-query decoder; raw tensors stay float32,
    # geometry and sigmoid use Python float/f64 exactly like the original model.py.
    detections=[];unsupported=[]
    for query,(row,box) in enumerate(zip(logits,boxes)):
        row=[float(v) for v in row];box=[float(v) for v in box]
        if not all(math.isfinite(v) for v in row+box): continue
        index=max(range(80),key=lambda i:row[i]);v=row[index]
        score=1/(1+math.exp(-v)) if v>=0 else math.exp(v)/(1+math.exp(v))
        if score<.5: continue
        cx,cy,w,h=box
        bbox=[max(0,min(p['width'],(cx-w/2)*p['width'])),max(0,min(p['height'],(cy-h/2)*p['height'])),max(0,min(p['width'],(cx+w/2)*p['width'])),max(0,min(p['height'],(cy+h/2)*p['height']))]
        if bbox[2]<=bbox[0] or bbox[3]<=bbox[1]: continue
        m=p['transform_to_canonical'];points=[]
        for x,y in [(bbox[0],bbox[1]),(bbox[2],bbox[1]),(bbox[2],bbox[3]),(bbox[0],bbox[3])]:
            z=m[6]*x+m[7]*y+m[8]
            points.append(((m[0]*x+m[1]*y+m[2])/z,(m[3]*x+m[4]*y+m[5])/z))
        bbox=[max(0,min(p['canonical_width'],min(x for x,y in points))),max(0,min(p['canonical_height'],min(y for x,y in points))),max(0,min(p['canonical_width'],max(x for x,y in points))),max(0,min(p['canonical_height'],max(y for x,y in points)))]
        if bbox[2]<=bbox[0] or bbox[3]<=bbox[1]: continue
        category=id2label.get(str(index));label=mapping.get(category)
        value={'query':query,'bbox_xyxy':bbox,'category':category,'score':score}
        if label is None: value['detector_index']=index;unsupported.append(value)
        else: value['label_id']=label;detections.append(value)
    return {'detections':sorted(detections,key=lambda v:-v['score']),'unsupported':sorted(unsupported,key=lambda v:-v['score'])}


def compare_decoded(expected,actual):
    maximum=0.
    for group in ('detections','unsupported'):
        # Exact retained query/category/label set, not just counts.
        def key(v): return (v['query'],v.get('label_id'),v['category'])
        if {key(v) for v in expected[group]}!={key(v) for v in actual[group]}: raise RuntimeError(f'{group}: retained query/label set mismatch; threshold is unchanged')
        by_key={key(v):v for v in actual[group]}
        for item in expected[group]:
            other=by_key[key(item)]
            error=max(abs(a-b) for a,b in zip(item['bbox_xyxy'],other['bbox_xyxy']))
            maximum=max(maximum,error)
            if error>.1: raise RuntimeError(f'canonical bbox error {error} exceeds0.1pixel')
    return maximum


def model_artifacts(directory):
    """Resolve BOTH actual leaf identities before any artifact read/hash/parse."""
    model_dir=confined(directory)
    paths=[]
    for name in ('manifest.json','model.onnx'):
        path=confined(model_dir/name)
        if not path.is_relative_to(model_dir): raise RuntimeError('model artifact path escape: '+name)
        paths.append(path)
    return model_dir,paths[0],paths[1]


def preflight_runtime():
    """Hash all pinned runtime/notice files before model loading; never load DLLs."""
    try:
        runtime=json.loads(confined(SOURCE.with_name('runtime-lock.json')).read_text(encoding='utf-8'))['runtime']
        installation=confined(RUNTIME.parent.parent)
        if runtime['library']['sha256']!=RUNTIME_SHA: raise RuntimeError('runtime dependency identity mismatch')
        for kind in ('library','shared_library','license','third_party_notices'):
            entry=runtime[kind];path=confined(installation/entry['path'])
            if not path.is_relative_to(installation): raise RuntimeError('runtime dependency path escape: '+kind)
            if kind=='library' and path!=confined(RUNTIME): raise RuntimeError('runtime dependency identity mismatch')
            if 'bytes' in entry and path.stat().st_size!=entry['bytes']: raise RuntimeError('runtime dependency size mismatch: '+kind)
            if digest(path)!=entry['sha256']: raise RuntimeError('runtime dependency hash mismatch: '+kind)
        return runtime
    except (OSError,KeyError,ValueError,TypeError,RuntimeError) as error:
        raise RuntimeError('runtime dependency preflight failed') from error


def resume_python_reference(report_path,manifest,versions,ledger):
    """Reuse only the first saved Python result from the same failed, unchanged run."""
    import numpy as np
    report_path=confined(report_path)
    previous=json.loads(report_path.read_text(encoding='utf-8'))
    if previous.get('kind')!='measured-model-equivalence' or previous.get('status')!='failed' or previous.get('cases')!=[]:
        raise RuntimeError('only a failed run before its first completed case can resume')
    expected={'versions':versions,'model_sha256':manifest['onnx']['sha256'],'runtime_sha256':RUNTIME_SHA,
              'atol':1e-4,'rtol':1e-4,'bbox_tolerance_pixels':.1}
    if any(previous.get(key)!=value for key,value in expected.items()):
        raise RuntimeError('retained Python reference provenance mismatch')
    state=ledger.ensure_available(0)
    if previous.get('forward_accounting')!=state or not state['receipts']:
        raise RuntimeError('retained Python reference ledger mismatch')
    request=state['receipts'][-1]
    charged=[receipt for receipt in state['receipts']
             if receipt['kind']=='python-top-level-forward' and receipt['pid']==request['pid']]
    if request['kind']!='rust-request' or len(charged)!=1 or charged[0]['sequence']>=request['sequence']:
        raise RuntimeError('retained Python reference has no unique prior forward receipt')
    sample=manifest['goldens'][0]
    reference_path=confined(report_path.parent/(sample['name']+'-python.npz'))
    if not reference_path.is_relative_to(report_path.parent) or reference_path.stat().st_size>2*1024*1024:
        raise RuntimeError('invalid retained Python reference file')
    try:
        with reference_path.open('rb') as handle:
            reference_sha256=hashlib.file_digest(handle,'sha256').hexdigest()
            handle.seek(0)
            with np.load(handle,allow_pickle=False) as saved:
                if set(saved.files)!={'logits','pred_boxes'}:
                    raise RuntimeError('invalid retained Python reference outputs')
                logits=saved['logits'];boxes=saved['pred_boxes']
        if logits.dtype!=np.float32 or boxes.dtype!=np.float32 or logits.shape!=(1,300,80) or boxes.shape!=(1,300,4):
            raise RuntimeError('invalid retained Python reference dtype or shape')
        if not np.isfinite(logits).all() or not np.isfinite(boxes).all():
            raise RuntimeError('nonfinite retained Python reference')
    except (OSError,ValueError,KeyError,TypeError) as error:
        raise RuntimeError('invalid retained Python reference') from error
    return {sample['name']:(logits,boxes)},{
        'source_report':str(report_path),'source_report_sha256':digest(report_path),
        'previous_binary_sha256':previous.get('binary_sha256'),
        'reference_path':str(reference_path),'reference_sha256':reference_sha256,
        'sample':sample['name'],'input_tensor_sha256':sample['tensor_sha256'],
        'python_receipt_sequence':charged[0]['sequence'],'prior_used':state['used']}


def run(args):
    offline();versions=identity()
    ledger=Ledger(args.budget_ledger,args.max_forwards)
    if not ledger.path.is_relative_to(FIXED_ROOT): raise RuntimeError('ledger outside fixed project root')
    resume_path=getattr(args,'resume_python_report',None)
    accounting_before=ledger.ensure_available(18) if resume_path is None else None
    root,lock=weights(args.weights_dir)
    model_dir,manifest_path,onnx_path=model_artifacts(args.model_dir)
    manifest=json.loads(manifest_path.read_text(encoding='utf-8'))
    if manifest['model_id']!=lock['model_id'] or manifest['source_files']!=lock['files']: raise RuntimeError('source pin mismatch')
    if digest(onnx_path)!=manifest['onnx']['sha256']: raise RuntimeError('ONNX hash mismatch')
    if graph(onnx_path)!=(manifest['ir_version'],manifest['opset']): raise RuntimeError('graph contract mismatch')
    if len(manifest['goldens'])!=6: raise RuntimeError('all six preprocessing scenarios required')
    binary=confined(args.weblabel_binary)
    if binary.name not in ('weblabel.exe','weblabel'): raise RuntimeError('must use real product executable, not test harness')
    runtime=preflight_runtime()
    # All file confinement/hash checks happen before loading model weights.
    for sample in manifest['goldens']:
        for key in ('image','tensor'):
            path=confined(model_dir/sample[key])
            if not path.is_relative_to(model_dir) or digest(path)!=sample[key+'_sha256']: raise RuntimeError('golden path/hash mismatch')
    references={};resume_proof=None
    if resume_path is not None:
        references,resume_proof=resume_python_reference(resume_path,manifest,versions,ledger)
        accounting_before=ledger.ensure_available(18-len(references))
    output=new_directory(args.report_dir)
    report={'kind':'measured-model-equivalence','versions':versions,'binary_sha256':digest(binary),'model_sha256':manifest['onnx']['sha256'],'runtime_sha256':RUNTIME_SHA,'atol':1e-4,'rtol':1e-4,'bbox_tolerance_pixels':.1,'cases':[],'status':'running'}
    report['runtime_files']={kind:runtime[kind] for kind in ('library','shared_library','license','third_party_notices')}
    report['resume_python_reference']=resume_proof
    report['forward_accounting_before']=accounting_before
    report['planned_new_forwards']={'python':6-len(references),'rust':12}
    try:
        import numpy as np
        # Operator boundary: source weights and derived artifacts remain immutable
        # with no concurrent writer through this operation. Transformers/ONNX reopen
        # paths; Python does NOT provide Rust's held-handle replacement exclusion.
        torch,model=load_model(root)
        # Explicit fixture mapping, never a guessed product ontology mapping.
        mapping={str(category):'synthetic-label-'+str(index) for index,category in model.config.id2label.items()}
        mapping_path=output/'synthetic-label-map.json';mapping_path.write_text(json.dumps(mapping),encoding='utf-8')
        with meter_model(model,ledger),torch.inference_mode():
            for sample in manifest['goldens']:
                name=sample['name'];tensor_path=confined(model_dir/sample['tensor'])
                if not tensor_path.is_relative_to(model_dir): raise RuntimeError('golden path/hash mismatch')
                with tensor_path.open('rb') as handle: raw=handle.read(3*640*640*4+1)
                if len(raw)!=3*640*640*4 or hashlib.sha256(raw).hexdigest()!=sample['tensor_sha256']: raise RuntimeError('golden tensor bytes/hash mismatch')
                # Hash the very bytes used for this forward, not a prior path open.
                array=np.frombuffer(raw,dtype='<f4').reshape(1,3,640,640)
                if not np.isfinite(array).all(): raise RuntimeError('nonfinite input')
                if name in references:
                    logits,boxes=references[name]
                else:
                    py=model(pixel_values=torch.from_numpy(array.copy()))
                    logits=py.logits.detach().cpu().numpy();boxes=py.pred_boxes.detach().cpu().numpy()
                if logits.shape!=(1,300,80) or boxes.shape!=(1,300,4): raise RuntimeError('Python output shape mismatch')
                if not np.isfinite(logits).all() or not np.isfinite(boxes).all(): raise RuntimeError('nonfinite Python output')
                if name not in references:
                    np.savez(output/(name+'-python.npz'),logits=logits,pred_boxes=boxes)
                w=sample['width'];h=sample['height']
                projection={'width':w,'height':h,'canonical_width':w,'canonical_height':h,'transform_to_canonical':[-1.,0.,float(w),0.,1.,0.,0.,0.,1.] if name=='mirror' else [1.,0.,0.,0.,1.,0.,0.,0.,1.]}
                if name=='rotate':
                    projection.update(canonical_width=h,canonical_height=w,transform_to_canonical=[0.,-1.,float(h),1.,0.,0.,0.,0.,1.])
                expected=reference(logits[0],boxes[0],manifest['id2label'],mapping,projection)
                case={'name':name,'python_reference_reused':name in references,'paths':[]}
                for kind in ('tensor','image'):
                    receipt=ledger.charge('rust-request') # Persisted BEFORE starting/sending Rust inference request.
                    request={'run_id':f'equivalence-{name}-{kind}','artifact_root':str(model_dir),'model_dir':str(model_dir),
                             'lock_path':str(SOURCE),
                             'runtime_library':str(RUNTIME),'runtime_sha256':RUNTIME_SHA,'label_map_path':str(mapping_path),
                             'input':{'kind':kind,'path':str(model_dir/sample[kind]),'sha256':sample[kind+'_sha256']},
                             'projection':projection,'timeout_ms':120000,'return_raw':True,
                             'budget_ticket':{'ledger':str(ledger.path),'sequence':receipt['sequence'],'nonce':receipt['nonce']}}
                    result=invoke(binary,request)
                    (output/(name+'-'+kind+'-rust.json')).write_text(json.dumps(result,allow_nan=False),encoding='utf-8')
                    if result['input_tensor_sha256']!=sample['tensor_sha256']: raise RuntimeError(f'{name} {kind}: preprocessing golden mismatch')
                    if result['projection']!=projection or result['region'] is not None: raise RuntimeError('worker crop/transform identity mismatch')
                    rlogits=np.array(result['raw_logits'],dtype=np.float32).reshape(1,300,80)
                    rboxes=np.array(result['raw_boxes'],dtype=np.float32).reshape(1,300,4)
                    np.testing.assert_allclose(rlogits,logits,atol=1e-4,rtol=1e-4)
                    np.testing.assert_allclose(rboxes,boxes,atol=1e-4,rtol=1e-4)
                    bbox_error=compare_decoded(expected,result['decoded'])
                    if result['receipt']['model_sha256']!=manifest['onnx']['sha256'] or result['receipt']['execution_provider']!='CPUExecutionProvider' or result['receipt']['cost'] is not None: raise RuntimeError('runtime receipt mismatch')
                    case['paths'].append({'kind':kind,'max_logits_absolute_error':float(np.max(np.abs(rlogits-logits))),'max_boxes_absolute_error':float(np.max(np.abs(rboxes-boxes))),'canonical_bbox_max_error':bbox_error,'detections':len(result['decoded']['detections']),'unsupported':len(result['decoded']['unsupported']),'receipt':result['receipt']})
                report['cases'].append(case)
        report['status']='passed'
        report['limitations']=['Synthetic images only; empty predictions do not prove detection quality, nonempty candidate acceptance, T32, or redistribution approval.']
    except BaseException as error:
        report['status']='failed';report['error']={'type':type(error).__name__,'message':str(error),'traceback':traceback.format_exc()}
        raise
    finally:
        report['forward_accounting']=ledger.ensure_available(0)
        (output/'equivalence.json').write_text(json.dumps(report,indent=2,allow_nan=False)+'\n',encoding='utf-8')
    print(json.dumps({'report_dir':str(output),'status':report['status']}))


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--weights-dir',type=Path,required=True)
    parser.add_argument('--model-dir',type=Path,required=True)
    parser.add_argument('--weblabel-binary',type=Path,required=True)
    parser.add_argument('--budget-ledger',type=Path,required=True)
    parser.add_argument('--max-forwards',type=int,required=True)
    parser.add_argument('--report-dir',type=Path,required=True)
    parser.add_argument('--resume-python-report',type=Path,help='Explicitly reuse the first retained Python reference from an unchanged failed run; never retries automatically.')
    run(parser.parse_args())
