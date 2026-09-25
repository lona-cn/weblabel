export type Tool = 'select' | 'box' | 'pan';

const tools: { id: Tool; label: string; glyph: string }[] = [
  { id: 'select', label: '选择工具', glyph: '↖' },
  { id: 'box', label: '矩形工具', glyph: '□' },
  { id: 'pan', label: '平移工具', glyph: '✋' },
];

export function Toolbar({ active, onChange, disabled = false }: { active: Tool; onChange: (tool: Tool) => void; disabled?: boolean }) {
  return (
    <div className="toolbar" role="toolbar" aria-label="画布工具">
      {tools.map((tool) => (
        <button
          key={tool.id}
          type="button"
          aria-label={tool.label}
          aria-pressed={active === tool.id}
          disabled={disabled}
          data-testid={`tool-${tool.id}`}
          className="tool-button"
          onClick={() => onChange(tool.id)}
        >
          <span aria-hidden="true">{tool.glyph}</span><span className="tool-label">{tool.label}</span>
        </button>
      ))}
    </div>
  );
}
