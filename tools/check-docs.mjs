import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import GithubSlugger from 'github-slugger';
import linkRule from 'markdown-it/lib/rules_inline/link.mjs';
import imageRule from 'markdown-it/lib/rules_inline/image.mjs';
import autolinkRule from 'markdown-it/lib/rules_inline/autolink.mjs';
import { HTML_TAG_RE } from 'markdown-it/lib/common/html_re.mjs';

const scope = 'documentation_structure_only_not_product_verification';
const entries = ['README.md', 'START_HERE.md', 'START_PROMPT.md', 'PLAN.md', 'AGENTS.md', 'prompts/RESUME.md', 'prompts/TASK_PACKET.md', 'prompts/REVIEW.md', 'reports/index.md'];
const types = new Set(['入口', '指南', '参考', '规范', '运行手册', '决策', '计划', '归档']);
const md = new MarkdownIt({ html: true, linkify: false, typographer: false });
// Parse unsafe schemes too, so unsupported URLs become explicit diagnostics.
md.validateLink = () => true;
// Preserve parser-derived locations; do not rescan Markdown with link regexes.
for (const [name, rule] of [['link', linkRule], ['image', imageRule], ['autolink', autolinkRule]]) {
  md.inline.ruler.at(name, (state, silent) => {
    const start = state.pos, count = state.tokens.length;
    const accepted = rule(state, silent);
    if (accepted && !silent) for (const token of state.tokens.slice(count)) {
      if ((token.type === 'link_open' || token.type === 'image') && token.meta?.lineOffset === undefined) {
        token.meta = { ...token.meta, lineOffset: state.src.slice(0, start).split('\n').length - 1 };
      }
    }
    return accepted;
  });
}
function htmlIds(content) {
  const tags = new RegExp(HTML_TAG_RE.source.slice(1), 'g');
  const ids = [];
  let rawText = null;
  for (const match of content.matchAll(tags)) {
    const tag = match[0], opening = /^<([a-z][a-z0-9-]*)\b/i.exec(tag);
    if (rawText) {
      if (new RegExp('^</' + rawText + '\\s*>$', 'i').test(tag)) rawText = null;
      continue;
    }
    if (!opening) continue; // Closing tags, comments, declarations and CDATA.
    const attributes = /\s+([a-z_:][a-z0-9:._-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^"'=<>\x60\x00-\x20]+)))?/gi;
    for (const attribute of tag.slice(opening[0].length).matchAll(attributes)) {
      if (attribute[1].toLowerCase() !== 'id') continue;
      const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
      // HTML keeps literal backslashes; protect them while decoding entities.
      ids.push(md.utils.unescapeAll(value.replaceAll('\\', '\\\\')));
      break; // HTML retains the first duplicate attribute.
    }
    if (/^(script|style|textarea|title|xmp|iframe|noembed|noframes|plaintext)$/i.test(opening[1])) rawText = opening[1];
  }
  return ids;
}
function tableCellCount(row) {
  row = row.trim();
  let count = 1;
  // Match the pinned parser's escaped-pipe semantics, including inline code.
  for (let i = 0; i < row.length; i++) if (row[i] === '|' && row[i - 1] !== '\\') count++;
  if (row.startsWith('|')) count--;
  if (row.endsWith('|') && row.at(-2) !== '\\') count--;
  return count;
}


const plain = tokens => (tokens ?? []).map(token => {
  if (token.type === 'text' || token.type === 'code_inline') return token.content;
  if (token.type === 'image') return plain(token.children);
  if (token.type === 'softbreak' || token.type === 'hardbreak') return '\n';
  return '';
}).join('');
const contained = (root, target) => {
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
};

export function checkDocs(root) {
  const diagnostics = [], documents = new Map();
  let files_checked = 0, links_checked = 0;
  const error = (file, line, message) => diagnostics.push({ file, line, message });
  const result = () => ({ ok: diagnostics.length === 0, scope, files_checked, links_checked,
    errors: diagnostics.sort((a, b) => a.file.localeCompare(b.file, 'en') || a.line - b.line || a.message.localeCompare(b.message, 'en')).map(item => `${item.file}:${item.line}: ${item.message}`) });
  try { root = fs.realpathSync(root); } catch { error('docs/README.md', 1, 'root read failed'); return result(); }
  const relative = file => path.relative(root, file).replaceAll('\\', '/');
  const safe = (file, source, line) => {
    if (!contained(root, file)) { error(source, line, 'target escapes root'); return false; }
    try {
      // Resolve before any byte read, including directory traversal and linked anchors.
      if (!contained(root, fs.realpathSync(file))) { error(source, line, 'real target escapes root'); return false; }
      return true;
    } catch { error(source, line, `target missing or inaccessible: ${relative(file)}`); return false; }
  };
  const load = (file, source = relative(file), line = 1) => {
    if (documents.has(file)) return documents.get(file);
    if (!safe(file, source, line)) return null;
    try {
      const sourceText = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
      const tokens = md.parse(sourceText, {}), anchors = new Set(), slugger = new GithubSlugger();
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].type === 'heading_open') anchors.add(slugger.slug(plain(tokens[i + 1].children)));
        for (const html of [tokens[i], ...(tokens[i].children ?? [])].filter(token => token.type === 'html_inline' || token.type === 'html_block')) {
          for (const id of htmlIds(html.content)) anchors.add(id);
        }
      }
      const document = { tokens, anchors, lines: sourceText.split('\n') };
      documents.set(file, document);
      return document;
    } catch { error(source, line, `document read failed: ${relative(file)}`); return null; }
  };
  const resolveLink = (file, line, href) => {
    if (/^(https?:|mailto:)/i.test(href)) return { external: true };
    let local, fragment;
    try {
      const hash = href.indexOf('#'), before = hash < 0 ? href : href.slice(0, hash);
      local = decodeURIComponent(before.split('?')[0]);
      fragment = decodeURIComponent(hash < 0 ? '' : href.slice(hash + 1));
    } catch { error(relative(file), line, 'invalid URL encoding'); return null; }
    if (/^[\\/]/.test(local) || /^[a-z][a-z0-9+.-]*:/i.test(local)) {
      error(relative(file), line, 'unsupported scheme or absolute local path');
      return null;
    }
    const target = local ? path.resolve(path.dirname(file), local) : file;
    if (!safe(target, relative(file), line)) return null;
    return { target, fragment };
  };
  const maintained = new Set(entries.map(file => path.resolve(root, file)));
  const visited = new Set();
  const walk = directory => {
    if (!safe(directory, relative(directory), 1)) return;
    const real = fs.realpathSync(directory);
    if (visited.has(real)) { error(relative(directory), 1, 'directory alias or cycle'); return; }
    visited.add(real);
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (!safe(file, relative(file), 1)) continue;
        if (fs.statSync(file).isDirectory()) walk(file);
        else if (entry.name.endsWith('.md')) maintained.add(file);
      }
    } catch { error(relative(directory), 1, 'directory read failed'); }
  };
  walk(path.join(root, 'docs'));
  const cards = new Set();
  const manifestFile = path.join(root, 'TASKS.json');
  if (safe(manifestFile, 'TASKS.json', 1)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      if (!Array.isArray(manifest.tasks)) throw new Error();
      for (const task of manifest.tasks) {
        if (typeof task.card !== 'string' || !task.card.endsWith('.md')) { error('TASKS.json', 1, 'invalid Markdown card'); continue; }
        const card = path.resolve(root, task.card);
        if (safe(card, 'TASKS.json', 1)) cards.add(card);
      }
    } catch { error('TASKS.json', 1, 'task manifest read failed'); }
  }

  const catalogFile = path.join(root, 'docs/README.md'), catalog = load(catalogFile);
  if (catalog) {
    const tokens = catalog.tokens;
    const heading = tokens.findIndex((token, index) => token.type === 'heading_open' && token.tag === 'h2' && plain(tokens[index + 1].children) === '文档目录');
    const end = tokens.findIndex((token, index) => index > heading && token.type === 'heading_open' && Number(token.tag.slice(1)) <= 2);
    const section = heading < 0 ? [] : tokens.slice(heading + 3, end < 0 ? tokens.length : end);
    if (section.filter(token => token.type === 'table_open').length !== 1) error('docs/README.md', 1, 'catalog section must contain one table');
    const registered = new Set();
    for (let i = 0; i < section.length; i++) {
      if (section[i].type !== 'tr_open') continue;
      const line = (section[i].map?.[0] ?? 0) + 1, cells = [];
      if (tableCellCount(catalog.lines[line - 1] ?? '') !== 6) error('docs/README.md', line, 'catalog row must have exactly six raw cells');
      let header = false;
      while (++i < section.length && section[i].type !== 'tr_close') {
        if (section[i].type === 'th_open') header = true;
        if (section[i].type === 'inline') cells.push(section[i]);
      }
      if (header) {
        const expected = ['文档', '类型', '读者与读后动作', '维护责任', '事实范围/权威依据', '更新触发'];
        if (JSON.stringify(cells.map(cell => plain(cell.children))) !== JSON.stringify(expected)) error('docs/README.md', line, 'catalog header must have six specified columns');
        continue;
      }
      if (cells.length !== 6 || cells.some(cell => !plain(cell.children).trim())) { error('docs/README.md', line, 'catalog requires six nonempty cells'); continue; }
      if (!types.has(plain(cells[1].children).trim())) error('docs/README.md', line, 'invalid catalog type');
      const links = cells[0].children.filter(token => token.type === 'link_open');
      if (links.length !== 1) { error('docs/README.md', line, 'catalog first cell must link one Markdown file'); continue; }
      const target = resolveLink(catalogFile, line, links[0].attrGet('href'));
      if (!target) continue;
      if (target.external || target.fragment || !target.target.endsWith('.md') || !fs.statSync(target.target).isFile()) { error('docs/README.md', line, 'catalog target must be a concrete local Markdown file'); continue; }
      if (registered.has(target.target)) error('docs/README.md', line, `duplicate catalog target: ${relative(target.target)}`);
      registered.add(target.target);
      if (!maintained.has(target.target)) error('docs/README.md', line, `catalog target outside registration scope: ${relative(target.target)}`);
    }
    for (const file of maintained) if (!registered.has(file)) error('docs/README.md', 1, `catalog entry missing: ${relative(file)}`);
  }
  for (const file of new Set([...maintained, ...cards])) {
    if (relative(file).startsWith('docs/reference/')) continue;
    const document = load(file);
    if (!document) continue;
    files_checked++;
    for (const token of document.tokens) for (const child of token.children ?? []) {
      const href = child.type === 'link_open' ? child.attrGet('href') : child.type === 'image' ? child.attrGet('src') : null;
      if (href === null) continue;
      links_checked++;
      const line = (token.map?.[0] ?? 0) + 1 + (child.meta?.lineOffset ?? 0);
      if (child.type === 'image' && !plain(child.children).trim()) error(relative(file), line, 'image alt must be nonempty');
      const resolved = resolveLink(file, line, href);
      if (!resolved || resolved.external || !resolved.fragment) continue;
      if (!resolved.target.endsWith('.md')) error(relative(file), line, 'anchor target is not Markdown');
      else {
        const target = load(resolved.target, relative(file), line);
        if (target && !target.anchors.has(resolved.fragment)) error(relative(file), line, `anchor missing: ${href}`);
      }
    }
  }
  return result();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const valid = args.length === 0 || (args.length === 2 && args[0] === '--root' && args[1] && !args[1].startsWith('--'));
  const result = valid ? checkDocs(args[1] ?? fileURLToPath(new URL('../', import.meta.url))) : { ok: false, scope, files_checked: 0, links_checked: 0, errors: ['CLI:1: expected only --root <directory>'] };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
