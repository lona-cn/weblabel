export interface DialogOptions {
  id: string;
  title: string;
  testId: string;
  signal: AbortSignal;
  fallbackFocus?: () => HTMLElement | null;
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
    const target = returnFocus; returnFocus = null;
    if (target?.isConnected) target.focus();
    const active = document.activeElement;
    // Native close can retain focus in a now non-rendered descendant until after this event.
    if (target && active !== target && (active === document.body || element.contains(active) && active?.getClientRects().length === 0)) {
      const fallback = options.fallbackFocus?.(); if (fallback?.isConnected) fallback.focus();
    }
  }
  function close() { if (element.open) element.close(); }
  function trapTab(event: KeyboardEvent) {
    if (event.key !== 'Tab' || event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
    let first: HTMLElement | undefined, last: HTMLElement | undefined;
    for (const control of element.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],summary,[tabindex]')) {
      if (control.tabIndex < 0 || control.matches(':disabled') || control.closest('[inert]') || !control.getClientRects().length || getComputedStyle(control).visibility === 'hidden') continue;
      first ??= control; last = control;
    }
    if (!first || !last) { event.preventDefault(); element.focus(); return; }
    const active = document.activeElement, edge = event.shiftKey ? first : last;
    if (active === edge || active === element || active instanceof HTMLElement && active.tabIndex < 0) {
      event.preventDefault(); (event.shiftKey ? last : first).focus();
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    close(); restoreFocus();
    closeButton.removeEventListener('click', close);
    element.removeEventListener('close', restoreFocus);
    element.removeEventListener('keydown', trapTab);
    options.signal.removeEventListener('abort', dispose);
    element.remove();
  }
  closeButton.addEventListener('click', close);
  element.addEventListener('close', restoreFocus);
  element.addEventListener('keydown', trapTab);
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
