import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';

export const PREVIEW_IDS = Object.freeze([
  ...Array.from({length:44},(_,i)=>`U${String(i+1).padStart(2,'0')}`),
  'U45-empty','U45-loading','U45-error','U45-forbidden'
]);
export const SCORE_DIMENSIONS = Object.freeze([
  'information_architecture','legibility','alignment_density','consistency','state_action_completeness'
]);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const within = (parent,child) => {
  const relative = path.relative(parent,child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};

export async function checkUIPreviews(catalogPath, projectRoot = process.cwd()) {
  const errors = [];
  let catalog, directory, root;
  const absoluteCatalog = path.resolve(catalogPath);
  try {
    root = await fs.realpath(projectRoot);
    const actualCatalog = await fs.realpath(absoluteCatalog);
    directory = path.dirname(actualCatalog);
    if (!within(root,actualCatalog) || directory !== root && !within(root,directory)) return {ok:false,scope:'generated_design_previews_only_not_product_verification',errors:['catalog escapes project directory']};
    catalog = JSON.parse(await fs.readFile(actualCatalog,'utf8'));
  } catch (error) { return {ok:false,scope:'generated_design_previews_only_not_product_verification',errors:[`catalog: ${error.message}`]}; }
  if (catalog.schema_version !== 1) errors.push('expected schema_version 1');
  if (!Array.isArray(catalog.items)) return {ok:false,scope:'generated_design_previews_only_not_product_verification',errors:[...errors,'items must be an array']};
  if (catalog.items.length !== PREVIEW_IDS.length) errors.push(`expected exactly ${PREVIEW_IDS.length} previews`);
  const seen = new Set(), images = new Set();
  const referenceHashes = new Map();
  async function inputDigest(inputPath) {
    const actual = await fs.realpath(path.resolve(root,inputPath));
    if (!within(root,actual) || !(await fs.stat(actual)).isFile()) throw new Error('reference must be an in-project file');
    if (!referenceHashes.has(actual)) referenceHashes.set(actual,createHash('sha256').update(await fs.readFile(actual)).digest('hex'));
    return referenceHashes.get(actual);
  }
  const selected = catalog.items.find(item=>item?.id === 'U10' && item.review?.status === 'accepted');
  let referenceDigest = null;
  try {
    if (nonempty(selected?.image_path) && !path.isAbsolute(selected.image_path)) {
      const actual = await fs.realpath(path.resolve(directory,selected.image_path));
      if (within(directory,actual)) {
        const digest = await inputDigest(actual);
        if (digest === selected.sha256) referenceDigest = digest;
      }
    }
  } catch { /* The selected item also receives its normal file/hash diagnostic below. */ }
  for (const item of catalog.items) {
    if (!item || typeof item !== 'object') { errors.push('invalid preview item'); continue; }
    const id = item.id;
    if (!PREVIEW_IDS.includes(id)) errors.push(`unknown preview: ${id}`);
    if (seen.has(id)) errors.push(`duplicate preview: ${id}`);
    seen.add(id);
    const compact = ['U24','U25','U26','U27'].includes(id);
    const width = compact ? 1024 : 1536, height = compact ? 1536 : 1024;
    if (item.viewport?.width !== width || item.viewport?.height !== height) errors.push(`${id}: invalid viewport`);
    if (!Number.isInteger(item.version) || item.version < 1) errors.push(`${id}: invalid version`);
    for (const field of ['scenario','text','tool_artifact']) if (!nonempty(item[field])) errors.push(`${id}: missing ${field}`);
    if (!Array.isArray(item.required_actions) || !item.required_actions.length || item.required_actions.some(value=>!nonempty(value))) errors.push(`${id}: missing required_actions`);
    if (!Array.isArray(item.source_paths) || !item.source_paths.length) errors.push(`${id}: missing source_paths`);
    else for (const source of item.source_paths) {
      try {
        if (!nonempty(source) || path.isAbsolute(source)) throw new Error('source path must be relative');
        const resolved = await fs.realpath(path.resolve(root,source));
        if (!within(root,resolved) || !(await fs.stat(resolved)).isFile()) throw new Error('source must be an in-project file');
      } catch (error) { errors.push(`${id}: invalid source ${source}: ${error.message}`); }
    }
    const prompt = item.prompt;
    if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) errors.push(`${id}: missing generation request`);
    else {
      for (const field of ['subject','style','composition','text']) if (!nonempty(prompt[field])) errors.push(`${id}: prompt missing ${field}`);
      if (prompt.aspect_ratio !== (compact ? '2:3' : '3:2') || prompt.image_size !== `${width}x${height}`) errors.push(`${id}: invalid requested image dimensions`);
      if (id !== 'U10') {
        let matchesReference = false;
        if (referenceDigest && Array.isArray(prompt.input)) for (const input of prompt.input) {
          if (!nonempty(input?.path)) continue;
          try { if (await inputDigest(input.path) === referenceDigest) { matchesReference = true; break; } }
          catch { /* Another input may be the preserved shared reference. */ }
        }
        if (!matchesReference) errors.push(`${id}: input does not identify the accepted U10 reference`);
      }
    }
    const review = item.review;
    if (review?.status !== 'accepted') errors.push(`${id}: review not accepted`);
    if (!Array.isArray(review?.hard_failures) || review.hard_failures.length !== 0) errors.push(`${id}: unresolved or missing hard_failures`);
    for (const role of ['author_score','reviewer_score']) {
      const score = review?.[role];
      if (!score || SCORE_DIMENSIONS.some(key=>!Number.isInteger(score[key]) || score[key] < 4 || score[key] > 5) || SCORE_DIMENSIONS.reduce((total,key)=>total+(score?.[key]??0),0) < 24) errors.push(`${id}: ${role} below acceptance threshold`);
    }
    try {
      if (!nonempty(item.image_path) || path.isAbsolute(item.image_path)) throw new Error('image_path must be relative to catalog');
      const image = await fs.realpath(path.resolve(directory,item.image_path));
      if (!within(directory,image)) throw new Error('image escapes preview directory');
      if (!(await fs.stat(image)).isFile()) throw new Error('image is not a file');
      const bytes = await fs.readFile(image);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (!/^[a-f0-9]{64}$/.test(item.sha256??'') || digest !== item.sha256) errors.push(`${id}: image sha256 mismatch`);
      if (images.has(digest)) errors.push(`${id}: duplicate page image`);
      images.add(digest);
      const decoded = sharp(bytes,{failOn:'warning',limitInputPixels:1536*1536});
      const metadata = await decoded.metadata();
      if (metadata.width !== width || metadata.height !== height || (metadata.pages??1) !== 1) errors.push(`${id}: decoded dimensions do not match viewport`);
      if (!['png','jpeg','webp'].includes(metadata.format)) errors.push(`${id}: unsupported preview format: ${metadata.format}`);
      else await decoded.stats();
    } catch (error) { errors.push(`${id}: image validation failed: ${error.message}`); }
  }
  for (const id of PREVIEW_IDS) if (!seen.has(id)) errors.push(`missing preview: ${id}`);
  return {ok:errors.length===0,scope:'generated_design_previews_only_not_product_verification',preview_count:catalog.items.length,accepted_count:catalog.items.filter(item=>item?.review?.status==='accepted').length,visual_review_is_external:true,errors};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) { console.error('usage: node tools/check-ui-previews.mjs <catalog-path>'); process.exitCode = 1; }
  else {
    try {
      const result = await checkUIPreviews(process.argv[2]);
      console.log(JSON.stringify(result,null,2));
      process.exitCode = result.ok ? 0 : 1;
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
