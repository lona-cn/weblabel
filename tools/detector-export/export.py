"""Explicit measured development export; never invoked by the product."""
import argparse
import json
from pathlib import Path
import traceback
from budget import Ledger,meter_model
from common import FIXED_ROOT,digest,identity,offline,weights,new_directory,load_model,goldens,graph


def run(args):
    offline()
    versions=identity()
    ledger=Ledger(args.budget_ledger,args.max_forwards)
    if not ledger.path.is_relative_to(FIXED_ROOT): raise RuntimeError('ledger outside fixed project root')
    ledger.ensure_available()
    root,lock=weights(args.weights_dir)
    output=new_directory(args.output_dir)
    try:
        torch,model=load_model(root)
        class Outputs(torch.nn.Module):
            def __init__(self,inner): super().__init__();self.inner=inner
            def forward(self,pixel_values):
                result=self.inner(pixel_values=pixel_values)
                return result.logits,result.pred_boxes
        wrapper=Outputs(model).eval()
        path=output/'model.onnx'
        with meter_model(model,ledger),torch.inference_mode():
            torch.onnx.export(wrapper,(torch.zeros((1,3,640,640),dtype=torch.float32),),str(path),
                              input_names=['pixel_values'],output_names=['logits','pred_boxes'],
                              dynamo=False,opset_version=18,external_data=False)
        ir,opset=graph(path)
        samples=goldens(root,output)
        manifest={'schema_version':1,'model_id':lock['model_id'],'source_revision':lock['revision'],
                  'source_files':lock['files'],'onnx':{'path':'model.onnx','bytes':path.stat().st_size,'sha256':digest(path)},
                  'ir_version':ir,'opset':opset,'converter':versions,'runtime':{'ort':'2.0.0-rc.15','onnxruntime':'1.23.2','provider':'CPUExecutionProvider'},
                  'input':lock['input'],'outputs':lock['outputs'],'preprocess':lock['preprocess'],'postprocess':lock['postprocess'],
                  'license':lock['license'],'id2label':model.config.id2label,'goldens':samples,
                  'equivalence':'not_run','budget_ledger':str(ledger.path),'forward_accounting':ledger.ensure_available(0)}
        # Only graph-checked exports get a manifest. Equivalence remains NOT RUN.
        (output/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,allow_nan=False,indent=2)+'\n',encoding='utf-8')
        print(json.dumps({'output_dir':str(output),'onnx_sha256':digest(path),'equivalence':'not_run'}))
    except BaseException as error:
        (output/'failure.json').write_text(json.dumps({'error':type(error).__name__,'message':str(error),'traceback':traceback.format_exc()},indent=2),encoding='utf-8')
        raise


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--weights-dir',type=Path,required=True)
    parser.add_argument('--output-dir',type=Path,required=True)
    parser.add_argument('--budget-ledger',type=Path,required=True)
    parser.add_argument('--max-forwards',type=int,required=True)
    run(parser.parse_args())
