// Test tooling only: explicit native Cargo example, never a product runtime.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { root } from '../../scripts/build.mjs';
import { projectOutputPath } from './report-paths.mjs';
let built;
export function nativeLifecycleFixture(directory) {
  const target = projectOutputPath(path.resolve(root, process.env.CARGO_TARGET_DIR ?? 'target'));
  const name = process.platform === 'win32' ? 'native-lifecycle-fixture.exe' : 'native-lifecycle-fixture';
  const source = path.join(target, 'debug/examples', name);
  if (built !== source) {
    const allowed = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'CARGO_HOME', 'RUSTUP_HOME', 'RUSTC', 'RUSTDOC', 'VCINSTALLDIR', 'WindowsSdkDir', 'INCLUDE', 'LIB', 'LIBPATH'];
    const env = Object.fromEntries(allowed.filter(key => process.env[key]).map(key => [key, process.env[key]]));
    Object.assign(env, { RUSTC_WRAPPER: '', RUSTUP_TOOLCHAIN: '1.96.0', RUSTUP_AUTO_INSTALL: '0' });
    execFileSync('cargo', ['build', '--offline', '--locked', '--manifest-path', path.join(root, 'Cargo.toml'), '--target-dir', target, '-p', 'weblabel-api', '--example', 'native-lifecycle-fixture'], { cwd: root, env, stdio: 'inherit' });
    built = source;
  }
  const destination = projectOutputPath(directory); fs.mkdirSync(destination, { recursive: true });
  const executable = path.join(destination, name); fs.copyFileSync(source, executable); fs.chmodSync(executable, 0o700);
  return executable;
}
