import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
const directory=path.resolve(process.argv[2]);
const before=await sharp(await readFile(path.join(directory,'device-loss-canvas-before.png'))).ensureAlpha().raw().toBuffer({resolveWithObject:true});
const after=await sharp(await readFile(path.join(directory,'device-loss-canvas-after.png'))).ensureAlpha().raw().toBuffer({resolveWithObject:true});
if(JSON.stringify(before.info)!==JSON.stringify(after.info)){const result={before:before.info,after:after.info,size_equal:false};await writeFile(path.join(directory,'raster-difference.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));process.exit(1);}
let different=0,minX=Infinity,minY=Infinity,maxX=-1,maxY=-1;const samples=[];
for(let offset=0;offset<before.data.length;offset+=4){if(!before.data.subarray(offset,offset+4).equals(after.data.subarray(offset,offset+4))){different+=1;const pixel=offset/4,x=pixel%before.info.width,y=Math.floor(pixel/before.info.width);minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);if(samples.length<12)samples.push({x,y,before:[...before.data.subarray(offset,offset+4)],after:[...after.data.subarray(offset,offset+4)]});}}
const result={dimensions:before.info,different_pixels:different,bounds:different?{minX,minY,maxX,maxY}:null,samples};
await writeFile(path.join(directory,'raster-difference.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
