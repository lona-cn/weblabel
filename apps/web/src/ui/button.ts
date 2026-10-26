export interface ButtonOptions {
  text: string;
  testId: string;
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  onClick?: (event: MouseEvent) => void;
  signal: AbortSignal;
}

export function createButton(options: ButtonOptions): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = options.type ?? 'button';
  element.textContent = options.text;
  element.dataset.testid = options.testId;
  element.disabled = options.disabled ?? false;
  if (options.onClick) element.addEventListener('click', options.onClick, { signal: options.signal });
  return element;
}
