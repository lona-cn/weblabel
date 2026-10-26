export interface FormFieldOptions {
  id: string;
  label: string;
  testId: string;
  control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  hint?: string;
}

export function createFormField({ id, label: text, testId, control, hint }: FormFieldOptions) {
  const element = document.createElement('div');
  const label = document.createElement('label');
  const description = document.createElement('p');
  const error = document.createElement('p');
  element.dataset.testid = testId;
  control.id = id;
  label.htmlFor = id;
  label.textContent = text;
  description.id = `${id}-hint`;
  description.textContent = hint ?? '';
  description.hidden = !hint;
  error.id = `${id}-error`;
  error.setAttribute('aria-live', 'polite');
  error.hidden = true;
  element.append(label, control, description, error);
  const initialDescriptions = control.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ?? [];
  function setError(message: string | null) {
    error.textContent = message ?? '';
    error.hidden = !message;
    control.setAttribute('aria-invalid', message ? 'true' : 'false');
    const ids = [...initialDescriptions, ...(hint ? [description.id] : []), ...(message ? [error.id] : [])];
    if (ids.length) control.setAttribute('aria-describedby', ids.join(' '));
    else control.removeAttribute('aria-describedby');
  }
  setError(null);
  return { element, control, setError };
}
