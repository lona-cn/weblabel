"""Inspect exact official package metadata and install only the authorized ORT archive.
No model imports, library loads, weights fetches, or inference in this utility.
"""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request
import zipfile

PINS={'torch':'2.14.0','transformers':'5.17.0','Pillow':'12.3.0','torchvision':'0.29.1','onnx':'1.18.0'}
EXPECTED='0b38df9af21834e41e73d602d90db5cb06dbd1ca618948b8f1d66d607ac9f3cd'
ROOT=Path('D:/workspace/src/weblabel').resolve()


def metadata():
    packages={}
    for name,version in PINS.items():
        url=f'https://pypi.org/pypi/{name}/{version}/json'
        with urllib.request.urlopen(url,timeout=60) as response: value=json.load(response)
        wheels=[{'filename':w['filename'],'sha256':w['digests']['sha256'],'bytes':w['size'],'url':w['url']} for w in value['urls'] if not w['yanked'] and ((('cp312' in w['filename']) and 'win_amd64' in w['filename']) or w['filename'].endswith('py3-none-any.whl'))]
        if not wheels: raise RuntimeError(f'no exact Windows CPython3.12 wheel: {name}=={version}')
        packages[name]={'version':value['info']['version'],'source':url,'license':value['info'].get('license_expression') or value['info'].get('license'),'wheels':wheels}
    return packages


def runtime():
    target=ROOT/'target/tools/onnxruntime-1.23.2'
    target.mkdir(parents=True,exist_ok=True)
    url='https://github.com/microsoft/onnxruntime/releases/download/v1.23.2/onnxruntime-win-x64-1.23.2.zip'
    archive=target/'onnxruntime-win-x64-1.23.2.zip'
    if not archive.exists():
        with urllib.request.urlopen(url,timeout=120) as response, archive.open('xb') as out:
            while chunk:=response.read(1024*1024): out.write(chunk)
    if hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()!=EXPECTED: raise RuntimeError('official runtime archive SHA mismatch; not extracting')
    with zipfile.ZipFile(archive) as source:
        for entry in source.infolist():
            destination=(target/entry.filename).resolve()
            if not destination.is_relative_to(target.resolve()): raise RuntimeError('archive path escape')
            if not destination.exists(): source.extract(entry,target)
    files=[{'path':str(p.relative_to(target)).replace('\\','/'),'bytes':p.stat().st_size,'sha256':hashlib.file_digest(p.open('rb'),'sha256').hexdigest()} for p in sorted(target.rglob('*')) if p.is_file() and p!=archive and p.name!='installation.json']
    receipt={'version':'1.23.2','platform':'win-x64','source':url,'archive_sha256':EXPECTED,'files':files,'loaded':False,'model_forwards':0}
    (target/'installation.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8')
    return receipt


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--metadata',action='store_true')
    parser.add_argument('--runtime',action='store_true')
    args=parser.parse_args()
    result={}
    if args.metadata: result['packages']=metadata()
    if args.runtime: result['runtime']=runtime()
    print(json.dumps(result,indent=2))
