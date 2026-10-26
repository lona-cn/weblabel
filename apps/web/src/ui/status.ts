export function createStatus(options: { testId: string; text?: string; urgent?: boolean }): HTMLParagraphElement {
  const element = document.createElement('p');
  element.dataset.testid = options.testId;
  element.setAttribute('role', options.urgent ? 'alert' : 'status');
  element.setAttribute('aria-atomic', 'true');
  element.textContent = options.text ?? '';
  return element;
}
