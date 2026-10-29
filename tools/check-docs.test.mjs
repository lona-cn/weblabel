import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDocs } from './check-docs.mjs';

const artifacts = fileURLToPath(new URL('../target/test-artifacts/documentation/', import.meta.url));
const registered = ['README.md', 'START_HERE.md', 'START_PROMPT.md', 'PLAN.md', 'AGENTS.md', 'PRODUCT.md', 'docs/README.md', 'prompts/RESUME.md', 'prompts/TASK_PACKET.md', 'prompts/REVIEW.md', 'reports/index.md'];
function fixture(t) {
  fs.mkdirSync(artifacts, { recursive: true });
  const root = fs.mkdtempSync(path.join(artifacts, 'docs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, value) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), value); };
  for (const file of registered) put(file, '# 示例\n');
  put('TASKS.json', JSON.stringify({ tasks: [] }));
  const row = file => `| [${file}](${encodeURI(path.posix.relative('docs', file))}) | 指南 | 阅读并行动 | main | 合成夹具 | 变更 |`;
  const catalog = extra => put('docs/README.md', '# 文档\n\n## 文档目录\n\n| 文档 | 类型 | 读者与读后动作 | 维护责任 | 事实范围/权威依据 | 更新触发 |\n|---|---|---|---|---|---|\n' + [...registered, ...extra].map(row).join('\n') + '\n');
  catalog([]);
  return { root, put, row, catalog };
}

test('a missing local target identifies the actual source file and line', t => {
  const f = fixture(t);
  f.put('README.md', '# 首页\n\n[缺失](missing.md)\n');
  const broken = checkDocs(f.root);
  assert.equal(broken.ok, false);
  assert.ok(broken.errors.some(error => error.startsWith('README.md:3:')));
  f.put('missing.md', '# 恢复\n');
  assert.equal(checkDocs(f.root).ok, true);
});

test('parsed Markdown resolves Chinese duplicate headings, HTML IDs, references and encoded files', t => {
  const f = fixture(t);
  f.put('docs/有 空格.md', '# 中文标题\n\n## 重复\n\n## 重复\n\n<a id="explicit-id"></a>\n');
  f.catalog(['docs/有 空格.md']);
  f.put('image.png', 'synthetic-image');
  f.put('README.md', '# 首页\n\n[中文](docs/有%20空格.md#中文标题)\n\n[重复](docs/有%20空格.md#重复-1)\n\n[显式][ref]\n\n![说明](image.png)\n\n[ref]: docs/有%20空格.md#explicit-id\n\n[页顶](#)\n\n' + '\x60\x60\x60md\n[不检查](absent.md)\n\x60\x60\x60\n\n~~~\n[也不检查](absent.md)\n~~~\n\n\x60[代码](absent.md)\x60\n');
  const accepted = checkDocs(f.root);
  assert.equal(accepted.ok, true, accepted.errors.join('\n'));
  f.put('README.md', '# 首页\n\n[坏锚点](docs/有%20空格.md#absent)\n');
  assert.ok(checkDocs(f.root).errors.some(error => error.startsWith('README.md:3:')));
});

test('catalog registration is complete, unique and has six populated legal metadata cells', t => {
  const f = fixture(t);
  f.put('docs/new-guide.md', '# 新指南\n');
  assert.equal(checkDocs(f.root).ok, false);
  f.catalog(['docs/new-guide.md']);
  assert.equal(checkDocs(f.root).ok, true);
  const valid = fs.readFileSync(path.join(f.root, 'docs/README.md'), 'utf8');
  for (const broken of [valid + f.row('docs/./new-guide.md') + '\n', valid.replace('| main |', '| |'), valid.replace('| 指南 |', '| 未知类型 |'), valid + f.row('docs/missing.md') + '\n', '# 没有目录\n']) {
    f.put('docs/README.md', broken);
    assert.equal(checkDocs(f.root).ok, false);
  }
});

test('images require descriptive alt text, while code fences and inline code are not links', t => {
  const f = fixture(t);
  f.put('image.png', 'synthetic-image');
  f.put('README.md', '# 首页\n\n![](image.png)\n');
  assert.equal(checkDocs(f.root).ok, false);
  f.put('README.md', '# 首页\n\n![合成图片](image.png)\n\n\x60[缺失](missing.md)\x60\n');
  assert.equal(checkDocs(f.root).ok, true);
  f.put('README.md', '# 首页\n\n普通段落\n[缺失](missing.md)\n');
  assert.ok(checkDocs(f.root).errors.some(error => error.startsWith('README.md:4:')));
});

test('URL and realpath boundaries refuse absolute paths, schemes, traversal and escaping junctions', t => {
  const f = fixture(t), outside = fixture(t);
  outside.put('external.md', '# 外部\n\n[不能读取](secret-never-read.md)\n');
  fs.symlinkSync(outside.root, path.join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const href of ['../external.md', 'escape/external.md#外部', '%E0%A4%A', 'file:///private.md', 'javascript:alert(1)', '/README.md', path.join(f.root, 'README.md').replaceAll('\\', '/')]) {
    f.put('README.md', '# 首页\n\n[不安全](<' + href + '>)\n');
    const rejected = checkDocs(f.root);
    assert.equal(rejected.ok, false, href);
    assert.ok(rejected.errors.some(error => error.startsWith('README.md:3:')), href);
    assert.ok(rejected.errors.every(error => !error.includes('secret-never-read')));
  }
  f.put('README.md', '# 首页\n\n[不联网](https://documentation.invalid/not-requested)\n');
  assert.equal(checkDocs(f.root).ok, true);
});

test('only registered maintenance documents and manifest cards have outgoing links checked', t => {
  const f = fixture(t);
  f.put('docs/reference/old.md', '# 旧记录\n\n[历史缺失](not-present.md)\n');
  f.put('reports/old/result.md', '# 历史报告\n\n[历史缺失](not-present.md)\n');
  f.put('target/unrelated.md', '[不是维护范围](not-present.md)\n');
  f.put('tasks/real-card.md', '# 卡片\n');
  f.put('TASKS.json', JSON.stringify({ tasks: [{ card: 'tasks/real-card.md' }] }));
  f.catalog(['docs/reference/old.md']);
  f.put('README.md', '# 首页\n\n[原始记录](docs/reference/old.md#旧记录)\n[报告](reports/old/result.md#历史报告)\n[目录](reports/)\n');
  assert.equal(checkDocs(f.root).ok, true);
  f.put('tasks/real-card.md', '# 卡片\n\n[维护卡片缺失](missing.md)\n');
  assert.ok(checkDocs(f.root).errors.some(error => error.startsWith('tasks/real-card.md:3:')));
  f.put('tasks/real-card.md', '# 卡片\n');
  f.put('README.md', '[失效引用](reports/old/result.md#没有这个锚点)\n');
  assert.ok(checkDocs(f.root).errors.some(error => error.startsWith('README.md:1:')));
});

test('HTML anchors are actual id attributes, not comments, data attributes or raw text', t => {
  const f = fixture(t);
  for (const html of ['<span data-id="ghost"></span>', '<!-- <a id="ghost"></a> -->', '<span title="id=\'ghost\'"></span>', '<script>const text = \'<a id="ghost"></a>\';</script>']) {
    f.put('README.md', '# 首页\n\n[不存在](#ghost)\n\n' + html + '\n');
    const checked = checkDocs(f.root);
    assert.equal(checked.ok, false, html);
    assert.ok(checked.errors.some(error => error.startsWith('README.md:3:')));
  }
  f.put('README.md', '[实际](#actual)\n\n<a class="example" id=actual></a>\n');
  assert.equal(checkDocs(f.root).ok, true);
});

test('catalog rejects extra raw cells without miscounting escaped pipes in text or code', t => {
  const f = fixture(t);
  const valid = fs.readFileSync(path.join(f.root, 'docs/README.md'), 'utf8');
  f.put('docs/README.md', valid.replace('| 变更 |', '| 变更 | unexpected seventh |'));
  assert.equal(checkDocs(f.root).ok, false);
  for (const cell of ['变化 \\| 触发', '\x60变化 \\| 触发\x60']) {
    f.put('docs/README.md', valid.replace('| 变更 |', '| ' + cell + ' |'));
    const accepted = checkDocs(f.root);
    assert.equal(accepted.ok, true, accepted.errors.join('\n'));
  }
});
