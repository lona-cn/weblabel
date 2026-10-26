import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
const RESERVED: Record<string, true> = { b: true, v: true, h: true, ' ': true };
export function categoryShortcuts(ontology: OntologyVersion | null): { bindings: Record<string, string>; warnings: string[] } {
  const counts: Record<string, number> = Object.create(null);
  for (const label of ontology?.labels ?? []) if (label.shortcut) { const key = label.shortcut.toLowerCase(); counts[key] = (counts[key] ?? 0) + 1; }
  const bindings: Record<string, string> = Object.create(null), warnings: string[] = [];
  for (const label of ontology?.labels ?? []) {
    if (!label.shortcut) continue;
    const key = label.shortcut.toLowerCase();
    if (counts[key] !== 1) warnings.push(label.name + '：快捷键 ' + label.shortcut + ' 重复，未绑定（类别定义仍合法）。');
    else if (RESERVED[key] || key.length !== 1 || !/^[!-~]$/.test(key)) warnings.push(label.name + '：快捷键 ' + label.shortcut + ' 与保留工具冲突或无法用于单键选择，未绑定。');
    else bindings[key] = label.label_id;
  }
  return { bindings, warnings };
}
