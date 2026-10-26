"""No-model gate: original AutoImageProcessor vs real Rust worker Probe, byte-exact.
No AutoModel, ONNX, ORT, detector forward, forward ledger or backend override.
"""
import argparse
import json
import traceback
from common import confined,digest,goldens,identity,new_directory,offline,weights
from verify import invoke


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--weights-dir',required=True)
    parser.add_argument('--weblabel-binary',required=True)
    parser.add_argument('--output-dir',required=True)
    args=parser.parse_args()
    offline();versions=identity();root,lock=weights(args.weights_dir)
    binary=confined(args.weblabel_binary);output=new_directory(args.output_dir)
    report={'schema_version':1,'scope':'processor_only_no_model','detector_forwards':0,'model_loaded':False,
        'versions':versions,'binary_sha256':digest(binary),'source_model_id':lock['model_id'],
        'reference':'original AutoImageProcessor.from_pretrained(local_files_only=True), default backend unchanged',
        'cases':[],'status':'failed'}
    try:
        import numpy as np
        for case in goldens(root,output):
            width,height=case['width'],case['height']
            request={'run_id':'processor-only-'+case['name'],'artifact_root':str(output),'timeout_ms':30000,
                'input':{'kind':'image','path':str(output/case['image']),'sha256':case['image_sha256']},
                'projection':{'width':width,'height':height,'canonical_width':width,'canonical_height':height,
                    'transform_to_canonical':[1,0,0,0,1,0,0,0,1]},'output_name':case['name']+'.rust.f32'}
            receipt=invoke(binary,request,method='probe')
            if receipt.get('kind')!='preprocess_only' or receipt.get('model_loaded') is not False or receipt.get('forward_completed') is not False or receipt.get('detector_forwards')!=0:
                raise RuntimeError('unexpected preprocessing-only worker receipt')
            expected_path=confined(output/case['tensor']);actual_path=confined(output/request['output_name'])
            if not expected_path.is_relative_to(output) or not actual_path.is_relative_to(output): raise RuntimeError('tensor path escape')
            if expected_path.stat().st_size!=3*640*640*4 or actual_path.stat().st_size!=3*640*640*4: raise RuntimeError('tensor byte count mismatch')
            actual_sha=digest(actual_path)
            if receipt.get('tensor_sha256')!=actual_sha or receipt.get('shape')!=[1,3,640,640] or receipt.get('dtype')!='float32-le': raise RuntimeError('tensor receipt mismatch')
            expected=np.fromfile(expected_path,dtype='<f4');actual=np.fromfile(actual_path,dtype='<f4')
            if not np.isfinite(expected).all() or not np.isfinite(actual).all(): raise RuntimeError('nonfinite preprocessing tensor')
            different=int(np.count_nonzero(expected.view('<u4')!=actual.view('<u4')))
            report['cases'].append({**case,'rust_tensor':actual_path.name,'rust_tensor_sha256':actual_sha,
                'different_elements':different,'max_abs_error':float(np.max(np.abs(expected-actual))),
                'byte_exact':actual_sha==case['tensor_sha256'],'receipt':receipt})
        if len(report['cases'])!=6 or any(not case['byte_exact'] for case in report['cases']):
            raise RuntimeError('original processor mismatch: no detector export or forward is authorized')
        report['status']='passed'
    except BaseException:
        report['error']=traceback.format_exc()
        raise
    finally:
        (output/'preprocess-report.json').write_text(json.dumps(report,indent=2,allow_nan=False)+'\n',encoding='utf-8')
    print(json.dumps(report,indent=2,allow_nan=False))


if __name__=='__main__': main()
