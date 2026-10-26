export function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function action(text: string, testId: string, signal: AbortSignal, callback: () => void): HTMLButtonElement {
  const button = element('button', text); button.type = 'button'; button.dataset.testid = testId;
  button.addEventListener('click', callback, { signal });
  return button;
}
export function labeled<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(text: string, control: T): HTMLLabelElement {
  const label = element('label'); label.append(element('span', text), control); return label;
}
export function option(value: string, text: string): HTMLOptionElement {
  const item = element('option', text); item.value = value; return item;
}
