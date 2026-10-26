import { afterEach, expect, it, vi } from 'vitest';
import { createSessionController, type SessionController } from '../app/session';
import { api, setCsrfToken, type AdminRecoveryStatus } from '../lib/t15/api';
import { createButton } from './button';
import { createFormField } from './form-field';

const controllers = new Set<SessionController>();
afterEach(() => {
  for (const controller of controllers) controller.dispose();
  controllers.clear();
  vi.restoreAllMocks();
  setCsrfToken(null);
  document.body.replaceChildren();
});

it('retains a committed bootstrap acknowledgement when browser storage fails', async () => {
  vi.spyOn(api, 'adminRecoveryStatus').mockResolvedValue({ state: 'disabled', request_id: null, username: null });
  const bootstrap = vi.spyOn(api, 'bootstrap').mockResolvedValue({ user_id: 'unit-user', username: 'unit-admin', csrf_token: 'unit-csrf' });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
  const controller = createSessionController(); controllers.add(controller);
  await controller.bootstrap('unit-launch-code', 'unit-password');
  expect(controller.getSnapshot()).toMatchObject({ kind: 'bootstrap_created', username: 'unit-admin', error: expect.any(String) });
  await controller.bootstrap('unit-launch-code', 'unit-password');
  expect(bootstrap).toHaveBeenCalledTimes(1);
});

it('keeps recovery writes unknown until a read-only request confirms the same request', async () => {
  const available: AdminRecoveryStatus = { state: 'available', request_id: '00000000-0000-4000-8000-000000000001', username: 'unit-admin' };
  const read = vi.spyOn(api, 'adminRecoveryStatus').mockResolvedValue(available);
  const write = vi.spyOn(api, 'adminRecover').mockRejectedValue(new Error('acknowledgement lost'));
  const controller = createSessionController(); controllers.add(controller);
  await controller.refresh();
  await controller.recover('unit-code', 'unit-password');
  expect(controller.getSnapshot()).toMatchObject({ kind: 'recovery', phase: 'unknown' });
  await controller.recover('unit-code', 'unit-password');
  expect(write).toHaveBeenCalledTimes(1);
  read.mockResolvedValue({ ...available, state: 'completed' });
  await controller.refresh();
  expect(controller.getSnapshot()).toMatchObject({ kind: 'recovery', phase: 'ready', status: { state: 'completed' } });
  expect(write).toHaveBeenCalledTimes(1);
});

it('aborts an owned status read and fences its late response on dispose', async () => {
  let release!: (status: AdminRecoveryStatus) => void;
  const response = new Promise<AdminRecoveryStatus>(resolve => { release = resolve; });
  let signal: AbortSignal | undefined;
  vi.spyOn(api, 'adminRecoveryStatus').mockImplementation(async ownedSignal => { signal = ownedSignal; return response; });
  const controller = createSessionController(); controllers.add(controller);
  const notify = vi.fn(); controller.subscribe(notify);
  const operation = controller.refresh();
  const before = controller.getSnapshot();
  const calls = notify.mock.calls.length;
  controller.dispose();
  expect(signal?.aborted).toBe(true);
  release({ state: 'disabled', request_id: null, username: null });
  await operation;
  expect(controller.getSnapshot()).toBe(before);
  expect(notify).toHaveBeenCalledTimes(calls);
});

it('renders untrusted field labels and errors as text while associating validation', () => {
  const control = document.createElement('input');
  const field = createFormField({ id: 'unit-field', testId: 'unit-field-wrapper', label: '<img src=x onerror=alert(1)>', hint: 'unit hint', control });
  document.body.append(field.element);
  field.setError('<script>untrusted</script>');
  expect(field.element.querySelector('img, script')).toBeNull();
  expect(field.element.querySelector('label')?.control).toBe(control);
  expect(control.getAttribute('aria-describedby')).toBe('unit-field-hint unit-field-error');
  expect(control.getAttribute('aria-invalid')).toBe('true');
  field.setError(null);
  expect(control.getAttribute('aria-describedby')).toBe('unit-field-hint');
  expect(control.getAttribute('aria-invalid')).toBe('false');
});

it('keeps native button activation and detaches the handler with its owner signal', () => {
  const owner = new AbortController(), onClick = vi.fn();
  const button = createButton({ text: '<b>unit action</b>', testId: 'unit-action', signal: owner.signal, onClick });
  document.body.append(button);
  expect(button.type).toBe('button');
  expect(button.querySelector('b')).toBeNull();
  button.click();
  expect(onClick).toHaveBeenCalledTimes(1);
  owner.abort(); button.click();
  expect(onClick).toHaveBeenCalledTimes(1);
});
