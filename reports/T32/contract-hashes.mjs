import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
for (const name of ['contracts.md', 'testing-contracts.md']) {
  const bytes = readFileSync(new URL(`../../docs/${name}`, import.meta.url));
  console.log(JSON.stringify({ path: `docs/${name}`, raw_sha256: sha(bytes), lf_normalized_sha256: sha(bytes.toString('utf8').replaceAll('\r\n', '\n')) }));
}
