import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { HostSession } from '../index';
import { ProviderRegistry } from '../registry';
import { providerDispatch, type HostConfiguration } from './dispatch';

const configPath = process.env.WEBLABEL_HOST_CONFIG;
const token = process.env.WEBLABEL_RUN_TOKEN;
if (!configPath || !isAbsolute(configPath) || !token) throw new Error('needs_configuration');
if (statSync(configPath).size > 1024 * 1024) throw new Error('host_configuration_too_large');
const config = JSON.parse(readFileSync(configPath, 'utf8')) as HostConfiguration;
if (!Array.isArray(config.providers) || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0) throw new Error('invalid_host_configuration');
const session = new HostSession({ registry: new ProviderRegistry(), input: process.stdin, output: process.stdout, logs: process.stderr, spawnPolicy: { trusted_executable_roots: [], allowed_env: [], cwd_root: process.cwd(), source_env: {} }, dispatch: providerDispatch(config, token), runTimeoutMs: config.timeoutMs });
await session.run();
