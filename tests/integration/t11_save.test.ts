import { expect, it } from 'vitest';

import { start_test_app } from '../support/app';

type ApiError = { code: string };

it('requires an explicit ontology version when reading an annotation head', async () => {
  const app = await start_test_app();
  try {
    const user = await app.as_user('admin');
    const response = await user.request<ApiError>(
      'GET',
      '/api/assets/missing-asset/annotation',
    );
    expect(response.status).toBe(400);
    expect(response.json.code).toBe('ONTOLOGY_VERSION_REQUIRED');
  } finally {
    await app.stop();
  }
});
