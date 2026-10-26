"""Offline, exact-version developer helpers; not a product runtime dependency."""
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys

FIXED_ROOT=Path('D:/workspace/src/weblabel').resolve()
SOURCE=Path(__file__).resolve().parents[2]/'models/detector/source-lock.json'
PINS={'torch':'2.14.0','transformers':'5.17.0','Pillow':'12.3.0','torchvision':'0.29.1','onnx':'1.18.0'}


def confined(path,exists=True):
    path=Path(path).resolve(strict=exists)
    if not path.is_relative_to(FIXED_ROOT): raise RuntimeError('path outside fixed project root')
    return path


def digest(path):
    with Path(path).open('rb') as handle: return hashlib.file_digest(handle,'sha256').hexdigest()


def identity():
    if sys.version_info[:2]!=(3,12): raise RuntimeError('converter requires Python3.12 exactly')
    actual={name:importlib.metadata.version(name) for name in PINS}
    if actual!=PINS: raise RuntimeError(f'exact converter dependency mismatch: {actual}')
    return {'python':sys.version.split()[0],**actual}


def offline():
    os.environ['HF_HUB_OFFLINE']='1'
    os.environ['TRANSFORMERS_OFFLINE']='1'
    os.environ['HF_HUB_DISABLE_TELEMETRY']='1'
    os.environ['DO_NOT_TRACK']='1'
    cache=FIXED_ROOT/'target/tools/detector-export/cache'
    cache.mkdir(parents=True,exist_ok=True)
    for key in ['HF_HOME','TORCH_HOME','XDG_CACHE_HOME','TEMP','TMP','TMPDIR']: os.environ[key]=str(cache)


def weights(directory):
    root=confined(directory)
    lock=json.loads(SOURCE.read_text(encoding='utf-8'))
    for entry in lock['files']:
        path=confined(root/entry['path'])
        if not path.is_relative_to(root): raise RuntimeError('weight symlink/junction escape')
        if path.stat().st_size!=entry['bytes'] or digest(path)!=entry['sha256']: raise RuntimeError(f'weights_hash_mismatch: {entry["path"]}')
    return root,lock


def new_directory(path):
    path=confined(path,exists=False)
    if path.exists(): raise RuntimeError('refusing existing output directory')
    path.mkdir(parents=True,exist_ok=False)
    return path


def load_model(root):
    # Metering is installed on the actual model before any call/export, not on a wrapper
    # that the exporter could bypass. No model.forward direct call anywhere in the tools.
    import torch
    from transformers import AutoModelForObjectDetection
    model=AutoModelForObjectDetection.from_pretrained(str(root),local_files_only=True,trust_remote_code=False)
    model.eval()
    return torch,model


def synthetic_images():
    from PIL import Image,ImageOps
    def pattern(w,h,alpha=False):
        image=Image.new('RGBA' if alpha else 'RGB',(w,h))
        image.putdata([((x*19+y*7)%256,(x*3+y*23)%256,(x*11+y*13)%256,*(((x*17+y*5)%256,) if alpha else ())) for y in range(h) for x in range(w)])
        return image
    rgb=pattern(73,51)
    return [('rgb',rgb),('alpha',pattern(73,51,True)),('wide',pattern(801,399)),('tall',pattern(399,801)),('mirror',ImageOps.mirror(rgb)),('rotate',rgb.transpose(Image.Transpose.ROTATE_90))]


def goldens(root,output):
    from transformers import AutoImageProcessor
    processor=AutoImageProcessor.from_pretrained(str(root),local_files_only=True,trust_remote_code=False)
    result=[]
    for name,image in synthetic_images():
        image_path=output/(name+'.png');image.save(image_path)
        tensor=processor(images=image.convert('RGB'),return_tensors='pt')['pixel_values'].contiguous().to(dtype=__import__('torch').float32,device='cpu')
        if tuple(tensor.shape)!=(1,3,640,640): raise RuntimeError('processor tensor shape mismatch')
        tensor_path=output/(name+'.f32');tensor_path.write_bytes(tensor.numpy().astype('<f4',copy=False).tobytes())
        result.append({'name':name,'image':image_path.name,'image_sha256':digest(image_path),'tensor':tensor_path.name,'tensor_sha256':digest(tensor_path),'width':image.width,'height':image.height})
    return result


def graph(path):
    import onnx
    model=onnx.load(str(path),load_external_data=False)
    onnx.checker.check_model(model,full_check=True)
    if not 0<model.ir_version<=11: raise RuntimeError(f'actual graph IR {model.ir_version} unsupported; never edit IR')
    opsets=[o.version for o in model.opset_import if o.domain in ('','ai.onnx')]
    if opsets!=[18]: raise RuntimeError(f'actual graph opset mismatch: {opsets}')
    if any(t.external_data for t in model.graph.initializer): raise RuntimeError('external data prohibited')
    def shape(value):
        typ=value.type.tensor_type
        if typ.elem_type!=onnx.TensorProto.FLOAT: raise RuntimeError('graph tensor must be float32')
        if any(not d.HasField('dim_value') for d in typ.shape.dim): raise RuntimeError('dynamic graph dimensions prohibited')
        return [d.dim_value for d in typ.shape.dim]
    if [(v.name,shape(v)) for v in model.graph.input]!=[('pixel_values',[1,3,640,640])]: raise RuntimeError('graph input mismatch')
    outputs={v.name:shape(v) for v in model.graph.output}
    if outputs!={'logits':[1,300,80],'pred_boxes':[1,300,4]}: raise RuntimeError(f'graph output mismatch: {outputs}')
    return model.ir_version,opsets[0]
