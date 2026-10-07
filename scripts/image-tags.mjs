import fs from 'node:fs';
import path from 'node:path';
import { requireNode, root } from './build.mjs';
requireNode();
const sha = process.env.GITHUB_SHA;
if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('required_github_commit');
if (process.argv[2] === '--record') {
  if (process.argv.length !== 3 || !/^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+@sha256:[a-f0-9]{64}$/.test(process.env.IMAGE ?? '')) throw new Error('image_digest_invalid');
  fs.mkdirSync(path.join(root, 'target'), { recursive: true });
  fs.writeFileSync(path.join(root, 'target/ghcr-distribution.json'), JSON.stringify({ source_commit: sha, image: process.env.IMAGE, version: process.env.VERSION || null, platform: 'linux/amd64', verification: 'registry-digest-real-auth-save-restart-integrity-smoke', network: 'native-linux-host-loopback', real_ai: 'not-run', g4: 'not-certified' }, null, 2));
} else {
  if (process.argv.length !== 2 || !process.env.GITHUB_OUTPUT || !/^[\w.-]+\/[\w.-]+$/.test(process.env.IMAGE_REPOSITORY ?? '')) throw new Error('required_image_repository_output');
  const image = 'ghcr.io/' + process.env.IMAGE_REPOSITORY.toLowerCase();
  const version = process.env.IMAGE_VERSION || '';
  if (version && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('image_version_invalid');
  if (!/^\d+$/.test(process.env.GITHUB_RUN_ID ?? '') || !/^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? '')) throw new Error('required_unique_workflow_run');
  const tags = [image + ':run-' + process.env.GITHUB_RUN_ID + '.' + process.env.GITHUB_RUN_ATTEMPT];
  const nl = String.fromCharCode(10);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, ['image=' + image, 'tags<<WEBLABEL_TAGS', ...tags, 'WEBLABEL_TAGS', ''].join(nl));
}
