import { afterEach, beforeEach, expect, it } from 'vitest';

import { start_test_app, type ApiClient, type TestApp } from '../support/app';

type ApiError = { code: string };

let app: TestApp | undefined;
let user: ApiClient;

beforeEach(async () => {
  const fresh = await start_test_app();
  // as_user owns cleanup if its real user/project/login preparation fails.
  user = await fresh.as_user('admin');
  app = fresh;
});

afterEach(async () => {
  const finished = app;
  app = undefined;
  await finished?.stop();
});

it('requires an explicit ontology version when reading an annotation head', async () => {
  const response = await user.request<ApiError>(
    'GET',
    '/api/assets/missing-asset/annotation',
  );
  expect(response.status).toBe(400);
  expect(response.json.code).toBe('ONTOLOGY_VERSION_REQUIRED');
});
