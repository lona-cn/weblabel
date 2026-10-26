export interface DialogOptions {
  id: string;
  title: string;
  testId: string;
  signal: AbortSignal;
}

export function createDialog(options: DialogOptions) {
  const element = document.createElement('dialog');
  const heading = document.createElement('h2');
  const content = document.createElement('div');
  const closeButton = document.createElement('button');
  let returnFocus: HTMLElement | null = null;
  let disposed = false;
  element.id = options.id;
  element.dataset.testid = options.testId;
  heading.id = `${options.id}-title`;
  heading.textContent = options.title;
  element.setAttribute('aria-labelledby', heading.id);
  closeButton.type = 'button';
  closeButton.textContent = '关闭';
  closeButton.dataset.testid = `${options.testId}-close`;
  element.append(heading, content, closeButton);
  function restoreFocus() {
    if (returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
  }
  function close() { if (element.open) element.close(); }
  function dispose() {
    if (disposed) return;
    disposed = true;
    close(); restoreFocus();
    closeButton.removeEventListener('click', close);
    element.removeEventListener('close', restoreFocus);
    options.signal.removeEventListener('abort', dispose);
    element.remove();
  }
  closeButton.addEventListener('click', close);
  element.addEventListener('close', restoreFocus);
  if (options.signal.aborted) dispose();
  else options.signal.addEventListener('abort', dispose, { once: true });
  return {
    element, content, close, dispose,
    open(trigger?: HTMLElement) {
      if (disposed || element.open) return;
      returnFocus = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      element.showModal();
    },
  };
}
