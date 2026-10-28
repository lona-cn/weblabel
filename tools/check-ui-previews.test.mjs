import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import sharp from 'sharp';
import {checkUIPreviews, PREVIEW_IDS, SCORE_DIMENSIONS} from './check-ui-previews.mjs';

const root = fileURLToPath(new URL('../',import.meta.url));
let directory, catalog, serial = 0;
before(async()=>{
  const parent = path.join(root,'target','test-artifacts','html-rust-rebuild','metadata');
  await fs.mkdir(parent,{recursive:true});
  directory = await fs.mkdtemp(path.join(parent,'preview-gate-'));
  await fs.writeFile(path.join(directory,'source.ts'),'// Synthetic checker fixture, not a product page.\n');
  const score = Object.fromEntries(SCORE_DIMENSIONS.map(key=>[key,5]));
  const items = [];
  for (const [index,id] of PREVIEW_IDS.entries()) {
    const compact = ['U24','U25','U26','U27'].includes(id);
    const width = compact ? 1024 : 1536, height = compact ? 1536 : 1024;
    // Test rasters exercise decoding and file identity only; never actual design previews.
    const bytes = await sharp({create:{width,height,channels:3,background:{r:index*5,g:20,b:40}}}).png().toBuffer();
    const image_path = `${id}.png`;
    await fs.writeFile(path.join(directory,image_path),bytes);
    items.push({id,source_paths:['source.ts'],viewport:{width,height},scenario:'Synthetic metadata test fixture',text:'Synthetic',required_actions:['Inspect'],prompt:{subject:'Synthetic checker test',style:'Synthetic',composition:'Full test raster',text:'Synthetic',aspect_ratio:compact?'2:3':'3:2',image_size:`${width}x${height}`,input:[{path:path.join(directory,'U10.png')}]},tool_artifact:'synthetic-test-only',image_path,sha256:createHash('sha256').update(bytes).digest('hex'),version:1,review:{author_score:{...score},reviewer_score:{...score},hard_failures:[],status:'accepted'}});
  }
  catalog = {schema_version:1,items};
});
after(async()=>{if(directory)await fs.rm(directory,{recursive:true,force:true});});
async function check(change = ()=>{}) {
  const candidate = structuredClone(catalog);
  change(candidate);
  const file = path.join(directory,`catalog-${serial++}.json`);
  await fs.writeFile(file,JSON.stringify(candidate));
  return checkUIPreviews(file,directory);
}

test('accepts 48 distinct decoded images with complete dual reviews',async()=>{
  const result = await check();
  assert.equal(result.ok,true,JSON.stringify(result.errors));
  assert.equal(result.preview_count,48);
  assert.equal(result.scope,'generated_design_previews_only_not_product_verification');
});
test('validates sources in a recorded revision and rejects a missing historical file',async()=>{
  const candidate=structuredClone(catalog);
  candidate.source_revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  for(const item of candidate.items)item.source_paths=['tools/check-ui-previews.mjs'];
  const file=path.join(directory,`catalog-${serial++}.json`);
  await fs.writeFile(file,JSON.stringify(candidate));
  const result=await checkUIPreviews(file,root);
  assert.equal(result.ok,true,JSON.stringify(result.errors));
  candidate.items[0].source_paths=['tools/preview-source-that-does-not-exist.mjs'];
  await fs.writeFile(file,JSON.stringify(candidate));
  const missing=await checkUIPreviews(file,root);
  assert.equal(missing.ok,false);
  assert.ok(missing.errors.some(error=>error.startsWith('U01: invalid source')));
  candidate.items[0].source_paths=['tools/check-ui-previews.mjs'];
  const tree=execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:root,encoding:'utf8'}).trim();
  for(const revision of [tree, candidate.source_revision + '0']) {
    candidate.source_revision=revision;
    await fs.writeFile(file,JSON.stringify(candidate));
    const invalid=await checkUIPreviews(file,root);
    assert.equal(invalid.ok,false);
    assert.ok(invalid.errors.includes('source_revision must identify an available full commit without network access'));
  }
});
test('missing a generic state cannot be hidden by duplicating another page',async()=>{
  const result = await check(value=>{value.items[value.items.length-1]=structuredClone(value.items[0]);});
  assert.equal(result.ok,false);
  assert.ok(result.errors.includes('missing preview: U45-forbidden'));
  assert.ok(result.errors.some(error=>error.startsWith('duplicate preview:')));
});
test('a high aggregate score cannot mask a weak dimension or hard failure',async()=>{
  const result = await check(value=>{
    value.items[0].review.author_score.legibility=3;
    value.items[1].review.hard_failures=['Primary action obscured'];
    value.items[2].review.reviewer_score=null;
    value.items[3].review.status='pending';
  });
  assert.equal(result.ok,false);
  assert.ok(result.errors.some(error=>error.includes('U01: author_score')));
  assert.ok(result.errors.some(error=>error.includes('U02: unresolved')));
  assert.ok(result.errors.some(error=>error.includes('U03: reviewer_score')));
  assert.ok(result.errors.includes('U04: review not accepted'));
});
test('changed bytes and duplicate page images are rejected independently',async()=>{
  const result = await check(value=>{
    value.items[0].sha256='0'.repeat(64);
    value.items[1].image_path=value.items[2].image_path;
    value.items[1].sha256=value.items[2].sha256;
  });
  assert.equal(result.ok,false);
  assert.ok(result.errors.includes('U01: image sha256 mismatch'));
  assert.ok(result.errors.some(error=>error.includes('duplicate page image')));
});
test('compact previews require the actual compact raster, not just changed metadata',async()=>{
  const result = await check(value=>{
    const compact = value.items.find(item=>item.id==='U24');
    compact.image_path=value.items[0].image_path;
    compact.sha256=value.items[0].sha256;
  });
  assert.equal(result.ok,false);
  assert.ok(result.errors.includes('U24: decoded dimensions do not match viewport'));
});
test('images and source files cannot escape their allowed directories',async()=>{
  const result = await check(value=>{
    value.items[0].image_path='../outside.png';
    value.items[1].source_paths=['../../../../../../package.json'];
  });
  assert.equal(result.ok,false);
  assert.ok(result.errors.some(error=>error.startsWith('U01: image validation failed:')));
  assert.ok(result.errors.some(error=>error.startsWith('U02: invalid source')));
});
test('corrupt raster bytes are rejected even with a matching digest',async()=>{
  const bytes = Buffer.from('not a decodable image');
  await fs.writeFile(path.join(directory,'corrupt.webp'),bytes);
  const result = await check(value=>{
    value.items[0].image_path='corrupt.webp';
    value.items[0].sha256=createHash('sha256').update(bytes).digest('hex');
  });
  assert.equal(result.ok,false);
  assert.ok(result.errors.some(error=>error.startsWith('U01: image validation failed:')));
});

test('valid SVG content cannot substitute for a generated raster preview',async()=>{
 const bytes=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="1024"><rect width="1536" height="1024" fill="#123456"/></svg>');
 await fs.writeFile(path.join(directory,'vector-disguised.webp'),bytes);
 const result=await check(value=>{
  value.items[0].image_path='vector-disguised.webp';
  value.items[0].sha256=createHash('sha256').update(bytes).digest('hex');
 });
 assert.equal(result.ok,false);
 assert.ok(result.errors.some(error=>error.includes('unsupported preview format: svg')));
});

test('shared input must exist and identify the accepted U10 image bytes',async()=>{
 const result=await check(value=>{
  value.items[0].prompt.input=[{path:path.join(directory,'does-not-exist.webp')}];
  value.items[1].prompt.input=[{path:path.join(directory,'U03.png')}];
 });
 assert.equal(result.ok,false);
 assert.ok(result.errors.includes('U01: input does not identify the accepted U10 reference'));
 assert.ok(result.errors.includes('U02: input does not identify the accepted U10 reference'));
});

test('a catalog outside the declared project is rejected before reading page evidence',async()=>{
 const declaredProject=path.join(directory,'declared-project');
 await fs.mkdir(declaredProject,{recursive:true});
 await fs.copyFile(path.join(directory,'source.ts'),path.join(declaredProject,'source.ts'));
 const catalogFile=path.join(directory,`outside-catalog-${serial++}.json`);
 await fs.writeFile(catalogFile,JSON.stringify(catalog));
 const result=await checkUIPreviews(catalogFile,declaredProject);
 assert.equal(result.ok,false);
 assert.ok(result.errors.includes('catalog escapes project directory'));
});

test('a junction cannot relocate catalog evidence outside its declared project',async()=>{
 const declaredProject=path.join(directory,'junction-project');
 await fs.mkdir(declaredProject,{recursive:true});
 await fs.copyFile(path.join(directory,'source.ts'),path.join(declaredProject,'source.ts'));
 const catalogName=`junction-catalog-${serial++}.json`;
 await fs.writeFile(path.join(directory,catalogName),JSON.stringify(catalog));
 const junction=path.join(declaredProject,'previews');
 await fs.symlink(directory,junction,process.platform==='win32'?'junction':'dir');
 try{
  const result=await checkUIPreviews(path.join(junction,catalogName),declaredProject);
  assert.equal(result.ok,false);
  assert.ok(result.errors.includes('catalog escapes project directory'));
 }finally{await fs.unlink(junction);}
});
