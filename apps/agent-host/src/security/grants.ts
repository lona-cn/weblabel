//! Run/project/media-hash bound image grants.
//!
//! The host never sees real media paths: the API issues a grant bound to a run,
//! a project and a media hash, rooted at a private staging directory. Paths are
//! resolved canonically and must stay inside the granted root; symlink and
//! junction escapes, traversal and absolute/drive/UNC paths are rejected.

import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep, win32, posix } from 'node:path';

export class GrantError extends Error {
  readonly code: string;

  constructor(code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'GrantError';
    this.code = code;
  }
}

export interface ImageGrant {
  grant_id: string;
  run_id: string;
  project_id: string;
  media_hash: string;
  /** Canonical absolute staging root this grant may read from. */
  root: string;
  created_at: string;
}

export interface GrantRequest {
  run_id: string;
  project_id: string;
  media_hash: string;
  relative_path: string;
}

export interface IssueGrantInput {
  run_id: string;
  project_id: string;
  media_hash: string;
  root: string;
}

const MAX_ID_LENGTH = 128;

function assertId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw new GrantError('invalid_grant_input', `${field} must be a non-empty string of at most ${MAX_ID_LENGTH} characters`);
  }
  return value;
}

export function resolveGrantPath(grant: ImageGrant, request: GrantRequest): string {
  if (request.run_id !== grant.run_id || request.project_id !== grant.project_id || request.media_hash !== grant.media_hash) {
    throw new GrantError('grant_binding_mismatch', 'run_id, project_id and media_hash must match the issued grant');
  }
  const { relative_path: target } = request;
  if (typeof target !== 'string' || target.length === 0 || target.includes('\0')) {
    throw new GrantError('grant_path_invalid', 'relative_path must be a non-empty path string');
  }
  if (isAbsolute(target) || win32.isAbsolute(target) || posix.isAbsolute(target) || /^[A-Za-z]:/.test(target)) {
    throw new GrantError('grant_path_absolute', 'absolute, drive and UNC paths are not grantable');
  }
  if (target.split(/[\\/]+/).includes('..')) {
    throw new GrantError('grant_path_traversal', '".." segments are rejected');
  }
  const resolved = resolve(grant.root, target);
  let canonical: string;
  try {
    canonical = realpathSync(resolved);
  } catch {
    throw new GrantError('grant_path_missing', 'target does not exist inside the granted root');
  }
  const contained = relative(grant.root, canonical);
  if (
    contained === '' ||
    contained === '..' ||
    contained.startsWith(`..${sep}`) ||
    isAbsolute(contained)
  ) {
    throw new GrantError('grant_path_escape', 'target resolves outside the granted root (symlink or junction escape)');
  }
  return canonical;
}

export class GrantStore {
  readonly #grants = new Map<string, ImageGrant>();
  readonly #idFactory: () => string;

  constructor(options: { idFactory?: () => string } = {}) {
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  issue(input: IssueGrantInput): ImageGrant {
    const run_id = assertId(input.run_id, 'run_id');
    const project_id = assertId(input.project_id, 'project_id');
    const media_hash = assertId(input.media_hash, 'media_hash');
    if (typeof input.root !== 'string' || !isAbsolute(input.root) || !existsSync(input.root)) {
      throw new GrantError('grant_root_missing', 'grant root must be an existing absolute directory');
    }
    const root = realpathSync(input.root);
    if (!statSync(root).isDirectory()) {
      throw new GrantError('grant_root_missing', 'grant root must be a directory');
    }
    const grant: ImageGrant = {
      grant_id: this.#idFactory(),
      run_id,
      project_id,
      media_hash,
      root,
      created_at: new Date().toISOString(),
    };
    this.#grants.set(grant.grant_id, grant);
    return grant;
  }

  resolve(grant_id: string, request: GrantRequest): string {
    const grant = this.#grants.get(grant_id);
    if (!grant) throw new GrantError('unknown_grant', grant_id);
    return resolveGrantPath(grant, request);
  }

  revoke(grant_id: string): void {
    this.#grants.delete(grant_id);
  }

  revokeRun(run_id: string): void {
    for (const [grant_id, grant] of this.#grants) {
      if (grant.run_id === run_id) this.#grants.delete(grant_id);
    }
  }
}
