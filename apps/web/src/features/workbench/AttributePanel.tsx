import type { AnnotationObject } from '../../../../../packages/contracts/generated/AnnotationObject';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import type { AttributeDef } from '../../../../../packages/contracts/generated/AttributeDef';

type Props = { object: AnnotationObject | null; ontology: OntologyVersion };

function invalidValue(definition: AttributeDef, value: unknown): boolean {
  if (value === undefined || value === null) return definition.required;
  if (definition.kind === 'enum') return typeof value !== 'string' || !definition.enum_values.includes(value);
  if (definition.kind === 'boolean') return typeof value !== 'boolean';
  if (definition.kind === 'number') {
    return typeof value !== 'number' || !Number.isFinite(value) ||
      (definition.min !== null && value < definition.min) ||
      (definition.max !== null && value > definition.max);
  }
  return typeof value !== 'string';
}

export function AttributePanel({ object, ontology }: Props) {
  const label = object ? ontology.labels.find((item) => item.label_id === object.label_id) : undefined;
  const schema = label?.attributes ?? [];
  const unknownKeys = object ? Object.keys(object.attributes).filter((key) => !schema.some((definition) => definition.key === key)) : [];

  return (
    <section className="attribute-panel" aria-labelledby="attribute-heading">
      <div className="panel-heading"><h2 id="attribute-heading">属性</h2></div>
      {!object ? <p className="muted">选择一个对象查看属性</p> : (
        <>
          <p className="selected-object" title={label?.name ?? object.label_id}>{label?.name ?? object.label_id}</p>
          {schema.length === 0 ? <p className="muted">该类别未定义属性</p> : null}
          <div className="attribute-fields">
            {schema.map((definition) => {
              const value = object.attributes[definition.key];
              const invalid = invalidValue(definition, value);
              const controlId = `attribute-${definition.key}`;
              return (
                <div className="attribute-field" key={definition.key}>
                  <label htmlFor={controlId}>{definition.key}{definition.required ? ' *' : ''}</label>
                  {definition.kind === 'enum' ? (
                    <select id={controlId} data-testid={`attribute-${definition.key}`} value={typeof value === 'string' ? value : ''} disabled aria-invalid={invalid}>
                      <option value="">未设置</option>
                      {definition.enum_values.map((entry) => <option value={entry} key={entry}>{entry}</option>)}
                      {typeof value === 'string' && !definition.enum_values.includes(value) ? <option value={value}>{value}</option> : null}
                    </select>
                  ) : definition.kind === 'boolean' ? (
                    <input id={controlId} data-testid={`attribute-${definition.key}`} type="checkbox" checked={value === true} disabled aria-invalid={invalid} readOnly />
                  ) : (
                    <input id={controlId} data-testid={`attribute-${definition.key}`} type={definition.kind === 'number' ? 'number' : 'text'} value={value === undefined || value === null ? '' : String(value)} disabled aria-invalid={invalid} readOnly />
                  )}
                  {invalid ? <span className="field-error" role="alert">值不符合当前属性规范</span> : null}
                </div>
              );
            })}
          </div>
          {unknownKeys.length ? <div className="unknown-values" role="alert" aria-label="未知属性值"><strong>未知属性值</strong><ul>{unknownKeys.map((key) => <li key={key}>{key}: {String(object.attributes[key])}</li>)}</ul></div> : null}
        </>
      )}
    </section>
  );
}
