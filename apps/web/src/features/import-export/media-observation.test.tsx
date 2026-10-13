import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../lib/t15/api';
import { MediaImportPanel } from './MediaImportPanel';

expect.extend(matchers);
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('observes an acknowledged queued upload through completion without resubmitting it', async () => {
  const upload = vi.spyOn(api, 'importAssets').mockResolvedValue({ import_job_id: 'queued-job', duplicate: false });
  vi.spyOn(api, 'job')
    .mockResolvedValueOnce({ job_id: 'queued-job', kind: 'media_import', state: 'queued', progress_completed: 0, progress_total: 1, result: null })
    .mockResolvedValue({ job_id: 'queued-job', kind: 'media_import', state: 'succeeded', progress_completed: 1, progress_total: 1,
      result: { items: [{ item_index: 0, state: 'succeeded', error: null, error_code: null, asset_revision_id: 'imported-image' }] } });
  const imported = vi.fn(async () => {});
  render(<MediaImportPanel projectId="queued-project" canImport onImported={imported} />);
  const user = userEvent.setup();
  await user.upload(screen.getByLabelText('媒体文件'), new File(['synthetic'], 'synthetic.png', { type: 'image/png' }));
  await user.click(screen.getByRole('button', { name: '上传媒体' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/^成功$/), { timeout: 3000 });
  expect(imported).toHaveBeenCalledTimes(1);
  expect(upload).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: '选择新的导入批次' })).toBeEnabled();
});
