import { useMemo, useRef, useState } from 'react';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';

import { categoryShortcuts } from './category-shortcuts';
export function LabelControls({ ontology, activeLabel, onActiveLabel, selectedCount, onSetLabel, disabled }: {
  ontology: OntologyVersion; activeLabel: string; onActiveLabel: (id: string) => void;
  selectedCount: number; onSetLabel: (id: string) => void; disabled: boolean;
}) {
  const [target, setTarget] = useState('');
  const help = useRef<HTMLDetailsElement>(null);
  const shortcuts = useMemo(() => categoryShortcuts(ontology), [ontology]);
  return <section className="label-controls" aria-label="类别工具">
    <label>绘制类别<select data-testid="drawing-label" value={activeLabel} disabled={disabled} onChange={event => onActiveLabel(event.target.value)}>{ontology.labels.map((label, index) => <option key={label.label_id} value={label.label_id}>{label.name} · {index + 1}</option>)}</select></label>
    <details className="label-advanced"><summary>选中对象改类与规则</summary><div className="fold-body">
    <div className="batch-label-controls"><label>选中对象改类<select data-testid="batch-label" value={target} disabled={disabled || !selectedCount} onChange={event => setTarget(event.target.value)}><option value="">选择目标类别</option>{ontology.labels.map((label, index) => <option key={label.label_id} value={label.label_id}>{label.name} · {index + 1}</option>)}</select></label><button type="button" data-testid="batch-label-apply" disabled={disabled || !selectedCount || !target} onClick={() => onSetLabel(target)}>应用到 {selectedCount} 个对象</button></div>
    <details><summary>改类与属性规则</summary><p>由共享 Rust 核心一次原子处理整批，一次撤销。目标类别默认值建立属性集合：同 key 且仍合法的旧值保留，未定义键删除，缺失或不兼容值使用目标默认值。null 按规范合法；同类对象完全不变，不重置属性。任一目标非法或锁定，整批不改；隐藏只影响可见性。</p></details>
    </div></details>
    <details ref={help} className="shortcut-help" onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); if (help.current) { help.current.open = false; help.current.querySelector('summary')?.focus(); } } }}><summary>快捷键帮助</summary><div className="fold-body"><p>V 选择 · B 画框 · H 平移 · 按住空格临时平移 · Esc 取消手势。Windows：Ctrl+Z 撤销、Ctrl+Shift+Z / Ctrl+Y 重做、Ctrl+D 复制；Mac：⌘+Z、⌘+Shift+Z / ⌘+Y、⌘+D。Delete / Backspace 删除。输入框、输入法组合及帮助内不触发编辑快捷键。</p><p>Ctrl / ⌘ / Shift 点击列表可增减多选；过滤不改变选择。类别快捷键仅选择绘制类别，不自动改类或保存。</p><ul>{Object.entries(shortcuts.bindings).map(([key, id]) => <li key={key}>{key.toUpperCase()}：{ontology.labels.find(label => label.label_id === id)?.name}</li>)}{shortcuts.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div></details>
  </section>;
}
