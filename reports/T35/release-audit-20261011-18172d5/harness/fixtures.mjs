import sharp from 'sharp'; import fs from 'node:fs'; import path from 'node:path';
const root='D:/workspace/src/weblabel',scratch=path.join(root,'target/build-cache/release-audit-20261011');
const w=640,h=480,pixels=Buffer.alloc(w*h*3);for(let y=0;y<h;y++)for(let x=0;x<w;x++){let i=(y*w+x)*3;let target=x>=80&&x<260&&y>=60&&y<190,secondary=x>=350&&x<470&&y>=230&&y<380;pixels[i]=target?240:secondary?30:24;pixels[i+1]=target?140:secondary?210:54;pixels[i+2]=target?20:secondary?230:72;}
await sharp(pixels,{raw:{width:w,height:h,channels:3}}).png().toFile(path.join(scratch,'synthetic.png'));console.log('Generated only programmatic 640x480 PNG');
