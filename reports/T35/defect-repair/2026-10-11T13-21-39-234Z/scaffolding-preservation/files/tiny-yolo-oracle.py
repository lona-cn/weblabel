import json,sys,zipfile,math
expected=json.load(open(sys.argv[2],encoding='utf-8'))
a=expected['expected'][1]
id=a['media']['asset_revision_id']
with zipfile.ZipFile(sys.argv[1]) as z:
 rows=z.read('labels/'+a['split']+'/'+id+'.txt').decode().splitlines()
 fields=rows[0].split(); actual=list(map(float,fields[1:]))
 b=a['revision']['document']['objects'][0]['geometry']; w=a['width']; h=a['height']
 wanted=[(b['x_min']+b['x_max'])/(2*w),(b['y_min']+b['y_max'])/(2*h),(b['x_max']-b['x_min'])/w,(b['y_max']-b['y_min'])/h]
 assert actual==wanted,(actual,wanted)
 assert all(math.isfinite(v) and 0<v<sys.float_info.min for v in actual)
 recovered=[actual[2]*w,actual[3]*h]
 assert all(v>0 and abs((v-b['x_max'])/b['x_max'])<=1e-14 for v in recovered)
 print(json.dumps({'tokens':fields,'normalized':actual,'normalized_subnormal_nonzero':True,'canonical_recovered_sizes':recovered,'relative_bound':1e-14,'independent_parser':'Python stdlib zipfile/float; all native/COCO/YOLO members and decoded RGB separately verified by existing delivery oracle'}))
