// apps/agent-host/src/runtime/main.ts
import { readFileSync as readFileSync2, statSync as statSync2 } from "node:fs";
import { isAbsolute as isAbsolute4 } from "node:path";

// apps/agent-host/src/protocol.ts
var PROTOCOL_VERSION = 1;
var MAX_LINE_BYTES = 4 * 1024 * 1024;
var ENVELOPE_KINDS = { request: true, response: true, event: true };
var ENVELOPE_METHODS = { probe: true, start_run: true, cancel_run: true, shutdown: true, run_event: true };
var REQUEST_METHODS = { probe: true, start_run: true, cancel_run: true, shutdown: true };
var MAX_ID_LENGTH = 128;
var ProtocolError = class extends Error {
  code;
  constructor(code, detail) {
    super(detail === void 0 ? code : `${code}: ${detail}`);
    this.name = "ProtocolError";
    this.code = code;
  }
};
function utf8ByteLength(text) {
  if (!/[^\x00-\x7f]/.test(text)) return text.length;
  return new TextEncoder().encode(text).length;
}
function assertValidEnvelope(input) {
  if (input.protocol_version !== PROTOCOL_VERSION) {
    throw new ProtocolError("protocol_version", `expected ${PROTOCOL_VERSION}, got ${JSON.stringify(input.protocol_version)}`);
  }
  const { id } = input;
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) {
    throw new ProtocolError("invalid_id", `id must be a non-empty string of at most ${MAX_ID_LENGTH} characters`);
  }
  const { kind } = input;
  if (typeof kind !== "string" || ENVELOPE_KINDS[kind] !== true) {
    throw new ProtocolError("invalid_kind", JSON.stringify(kind));
  }
  const { method } = input;
  if (typeof method !== "string" || ENVELOPE_METHODS[method] !== true) {
    throw new ProtocolError("unknown_method", JSON.stringify(method));
  }
  if (kind === "request" && REQUEST_METHODS[method] !== true) {
    throw new ProtocolError("invalid_kind_method_pair", `${method} cannot be a request`);
  }
  if (kind === "event" && method !== "run_event") {
    throw new ProtocolError("invalid_kind_method_pair", `${method} cannot be an event`);
  }
  if (!("payload" in input)) {
    throw new ProtocolError("invalid_envelope", "payload field is required");
  }
  return {
    protocol_version: PROTOCOL_VERSION,
    id,
    kind,
    method,
    payload: input.payload
  };
}
function parseEnvelope(line) {
  if (typeof line !== "string") {
    throw new ProtocolError("invalid_line", "envelope must be a string line");
  }
  if (line.includes("\n") || line.includes("\r")) {
    throw new ProtocolError("multi_line_message", "an envelope must occupy exactly one line");
  }
  const byteLength4 = utf8ByteLength(line);
  if (byteLength4 > MAX_LINE_BYTES) {
    throw new ProtocolError("message_too_large", `${byteLength4} bytes exceeds the ${MAX_LINE_BYTES} byte limit`);
  }
  let decoded;
  try {
    decoded = JSON.parse(line);
  } catch (error) {
    throw new ProtocolError("invalid_json", error instanceof Error ? error.message : "unparseable line");
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new ProtocolError("invalid_envelope", "envelope must be a JSON object");
  }
  return assertValidEnvelope(decoded);
}
function serializeEnvelope(envelope) {
  const validated = assertValidEnvelope({ ...envelope });
  const line = JSON.stringify(validated);
  const byteLength4 = utf8ByteLength(line);
  if (byteLength4 > MAX_LINE_BYTES) {
    throw new ProtocolError("message_too_large", `${byteLength4} bytes exceeds the ${MAX_LINE_BYTES} byte limit`);
  }
  return line;
}
var NdjsonFramer = class {
  #pending = "";
  push(chunk) {
    this.#pending += chunk;
    const lines = [];
    for (; ; ) {
      const index = this.#pending.indexOf("\n");
      if (index < 0) break;
      const raw = this.#pending.slice(0, index);
      this.#pending = this.#pending.slice(index + 1);
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
        this.#pending = "";
        throw new ProtocolError("message_too_large", `streamed line exceeds the ${MAX_LINE_BYTES} byte limit`);
      }
      lines.push(line);
    }
    if (Buffer.byteLength(this.#pending, "utf8") > MAX_LINE_BYTES) {
      this.#pending = "";
      throw new ProtocolError("message_too_large", `streamed line exceeds the ${MAX_LINE_BYTES} byte limit`);
    }
    return lines;
  }
  flush() {
    if (this.#pending.length > 0) {
      this.#pending = "";
      throw new ProtocolError("truncated_message", "stream ended in the middle of a message");
    }
  }
};
var RequestIdTracker = class {
  #seen = /* @__PURE__ */ new Set();
  track(id) {
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) {
      throw new ProtocolError("invalid_id", `id must be a non-empty string of at most ${MAX_ID_LENGTH} characters`);
    }
    if (this.#seen.has(id)) {
      throw new ProtocolError("duplicate_request_id", `request id ${id} was already used`);
    }
    this.#seen.add(id);
  }
};

// apps/agent-host/src/security/redaction.ts
var REDACTED = "[REDACTED]";
var IMAGE_REDACTED = "[IMAGE_BYTES_REDACTED]";
var DATA_URL = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
var SENSITIVE_HEADER = /\b(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi;
var AUTH_SCHEME = /\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
var API_KEY = /\b(?:sk|tp)-[A-Za-z0-9_-]{8,}\b/g;
var JWT_LIKE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
var KEYED_SECRET = /\b(api[-_]?key|api[-_]?secret|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|secret|token|session|cookie)([=:]\s*)("[^"]*"|'[^']*'|\S+)/gi;
var BASE64_BLOB = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{256,}={0,2}(?![A-Za-z0-9+/=])/g;
var SENSITIVE_KEY = /(^|[._-])(secret|token|password|passwd|pwd|apikey|authorization|cookie|cookies|credential|credentials|bearer|private[-_]?key|api[-_]?key|access[-_]?key|secret[-_]?key|client[-_]?secret)([._-]|$)/i;
var REFERENCE_KEY = /(_ref|_alias)$/i;
var IMAGE_KEY = /(image|bytes|blob|data)/i;
function redactText(text, knownSecrets = []) {
  for (const secret of knownSecrets) {
    if (secret.length > 0) text = text.replaceAll(secret, REDACTED);
  }
  return text.replace(DATA_URL, IMAGE_REDACTED).replace(SENSITIVE_HEADER, (match, header) => `${header}: ${REDACTED}`).replace(AUTH_SCHEME, (match, scheme) => `${scheme} ${REDACTED}`).replace(API_KEY, REDACTED).replace(JWT_LIKE, REDACTED).replace(KEYED_SECRET, (match, key, separator) => `${key}${separator}${REDACTED}`).replace(BASE64_BLOB, IMAGE_REDACTED);
}
function redactValue(value, keyHint, knownSecrets = []) {
  if (typeof value === "string") return redactText(value, knownSecrets);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return IMAGE_REDACTED;
  if (Array.isArray(value)) {
    const isImageBytes = keyHint !== void 0 && IMAGE_KEY.test(keyHint) && value.length > 32 && value.every((item) => typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 255);
    if (isImageBytes) return IMAGE_REDACTED;
    return value.map((item) => redactValue(item, keyHint, knownSecrets));
  }
  if (typeof value === "object") {
    const redacted = {};
    for (const [key, item] of Object.entries(value)) {
      const safeKey = redactText(key, knownSecrets);
      if (REFERENCE_KEY.test(key)) redacted[safeKey] = redactValue(item, key, knownSecrets);
      else if (SENSITIVE_KEY.test(key)) redacted[safeKey] = REDACTED;
      else redacted[safeKey] = redactValue(item, key, knownSecrets);
    }
    return redacted;
  }
  return void 0;
}

// apps/agent-host/src/security/spawn.ts
import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
var SpawnPolicyError = class extends Error {
  code;
  constructor(code, detail) {
    super(detail === void 0 ? code : `${code}: ${detail}`);
    this.name = "SpawnPolicyError";
    this.code = code;
  }
};
var ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
var RECLAIM_DEADLINE_MS = 5e3;
function canonicalExisting(target, label) {
  if (typeof target !== "string" || target.length === 0 || !isAbsolute(target)) {
    throw new SpawnPolicyError(`${label}_untrusted`, "must be an absolute path");
  }
  if (target.includes("\0")) throw new SpawnPolicyError(`${label}_invalid`, "NUL byte in path");
  let canonical2;
  try {
    canonical2 = realpathSync(target);
  } catch {
    throw new SpawnPolicyError(`${label}_missing`, target);
  }
  return canonical2;
}
function isUnderAny(target, roots) {
  return roots.some((root) => {
    let canonicalRoot;
    try {
      canonicalRoot = realpathSync(root);
    } catch {
      throw new SpawnPolicyError("trusted_root_missing", root);
    }
    const rel = relative(canonicalRoot, target);
    return rel === "" || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
  });
}
function buildChildEnv(overrides, policy) {
  const source = policy.source_env ?? process.env;
  const sourceKeys = /* @__PURE__ */ new Map();
  for (const key of Object.keys(source)) sourceKeys.set(key.toLowerCase(), key);
  const env = {};
  for (const key of policy.allowed_env) {
    if (!ENV_NAME.test(key)) throw new SpawnPolicyError("env_name_invalid", key);
    const sourceKey = sourceKeys.get(key.toLowerCase());
    const value = sourceKey === void 0 ? void 0 : source[sourceKey];
    if (typeof value === "string") env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!ENV_NAME.test(key)) throw new SpawnPolicyError("env_name_invalid", key);
    if (!policy.allowed_env.includes(key)) throw new SpawnPolicyError("env_not_allowlisted", key);
    if (typeof value !== "string") throw new SpawnPolicyError("env_value_invalid", key);
    env[key] = value;
  }
  return env;
}
function exitPromise(child) {
  const { promise, resolve: resolve4 } = Promise.withResolvers();
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve4({ code: child.exitCode, signal: child.signalCode });
  } else {
    child.once("exit", (code, signal) => resolve4({ code, signal }));
  }
  return promise;
}
function delay(ms) {
  const { promise, resolve: resolve4 } = Promise.withResolvers();
  setTimeout(resolve4, ms);
  return promise;
}
function systemTool(name) {
  if (process.platform !== "win32") return name;
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const candidates = [
    resolve(systemRoot, "System32", name),
    resolve(systemRoot, "System32", "WindowsPowerShell", "v1.0", name)
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  return found ?? name;
}
function runTool(executable, argv) {
  const { promise, resolve: resolve4 } = Promise.withResolvers();
  const child = spawnProcess(executable, argv, {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore"]
  });
  child.once("error", () => resolve4(null));
  child.once("exit", (code) => resolve4(code));
  return promise;
}
function parseProcessTable(output) {
  const records = /* @__PURE__ */ new Map();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*(\S*)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const created = match[3] === "" ? null : Date.parse(match[3]);
    records.set(pid, {
      ppid: Number(match[2]),
      created_ms: Number.isNaN(created) ? null : created
    });
  }
  return records;
}
function snapshotProcessTable() {
  const result = process.platform === "win32" ? spawnSync(
    systemTool("powershell.exe"),
    [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToUniversalTime().ToString('o'))" }`
    ],
    { encoding: "utf8", windowsHide: true }
  ) : spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  return parseProcessTable(result.stdout ?? "");
}
function findDescendants(rootPid, table) {
  const found = [];
  const queue = [rootPid];
  const seen = /* @__PURE__ */ new Set([rootPid]);
  while (queue.length > 0) {
    const current = queue.shift();
    for (const [pid, record] of table) {
      if (record.ppid !== current || seen.has(pid)) continue;
      seen.add(pid);
      found.push(pid);
      queue.push(pid);
    }
  }
  return found;
}
function stillSameProcess(target, table) {
  const record = table.get(target.pid);
  if (!record) return false;
  if (record.created_ms === null || target.created_ms === null) return true;
  return record.created_ms === target.created_ms;
}
async function reclaimProcessTree(root, reason) {
  const cutoffMs = Date.now();
  const table = snapshotProcessTable();
  const rootRecord = table.get(root.root_pid);
  const rootIsOurs = rootRecord === void 0 || rootRecord.created_ms === null || rootRecord.created_ms <= root.spawned_at_ms;
  const lineageUpperMs = root.exited_at_ms ?? cutoffMs;
  const descendants = findDescendants(root.root_pid, table).filter((pid) => {
    const record = table.get(pid);
    if (record?.created_ms == null) return true;
    return record.created_ms >= root.spawned_at_ms && record.created_ms <= lineageUpperMs;
  });
  const targets = [
    ...rootIsOurs ? [root.root_pid] : [],
    ...descendants
  ].map((pid) => ({ pid, created_ms: table.get(pid)?.created_ms ?? null }));
  const mechanism = process.platform === "win32" ? "windows taskkill /T + CIM descendant sweep (creation-time identity checked)" : "posix signal sweep (ps snapshot + SIGKILL; ps exposes no creation time, so creation identity is unavailable on POSIX)";
  if (process.platform === "win32") {
    if (rootIsOurs) {
      await runTool(systemTool("taskkill.exe"), ["/pid", String(root.root_pid), "/T", "/F"]);
    }
    for (const target of targets) {
      if (target.pid === root.root_pid) continue;
      if (stillSameProcess(target, snapshotProcessTable())) {
        await runTool(systemTool("taskkill.exe"), ["/pid", String(target.pid), "/F"]);
      }
    }
  } else {
    for (const target of targets) {
      try {
        process.kill(target.pid, "SIGKILL");
      } catch {
      }
    }
  }
  const deadline = Date.now() + RECLAIM_DEADLINE_MS;
  for (; ; ) {
    const alive = targets.filter((target) => stillSameProcess(target, snapshotProcessTable()));
    if (alive.length === 0) break;
    if (Date.now() >= deadline) {
      throw new SpawnPolicyError("reclaim_incomplete", `${reason}: pids still alive after reclaim: ${alive.map((t) => t.pid).join(",")}`);
    }
    await delay(250);
  }
  return {
    root_pid: root.root_pid,
    mechanism,
    descendants_found: descendants,
    killed: targets.map((target) => target.pid)
  };
}
function spawnChild(spec, policy) {
  if (spec.shell) {
    throw new SpawnPolicyError("shell_forbidden", "shell:true is never allowed; launch executables with argv arrays");
  }
  if (!Array.isArray(spec.argv) || spec.argv.some((argument) => typeof argument !== "string")) {
    throw new SpawnPolicyError("argv_must_be_array", "argv must be a string array; shell string concatenation is forbidden");
  }
  if (spec.argv.some((argument) => argument.includes("\0"))) {
    throw new SpawnPolicyError("argv_invalid", "argv must not contain NUL bytes");
  }
  const executable = canonicalExisting(spec.executable, "executable");
  if (statSync(executable).isDirectory() || !isUnderAny(executable, policy.trusted_executable_roots)) {
    throw new SpawnPolicyError("executable_untrusted", `${spec.executable} is outside the trusted executable roots`);
  }
  const cwd = canonicalExisting(spec.cwd, "cwd");
  if (!statSync(cwd).isDirectory() || !isUnderAny(cwd, [policy.cwd_root])) {
    throw new SpawnPolicyError("cwd_untrusted", `${spec.cwd} is outside the restricted cwd root`);
  }
  const env = buildChildEnv(spec.env, policy);
  const child = spawnProcess(executable, spec.argv, {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  if (child.pid === void 0) {
    throw new SpawnPolicyError("spawn_failed", `could not launch ${spec.executable}`);
  }
  const pid = child.pid;
  const started_at_ms = Date.now();
  const exited = exitPromise(child);
  return {
    pid,
    started_at_ms,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    wait: () => exited,
    killTree: (reason) => reclaimProcessTree({ root_pid: pid, spawned_at_ms: started_at_ms }, reason)
  };
}
async function superviseChild(child, options = {}) {
  const exited = child.wait();
  const { promise: stopped, resolve: stop } = Promise.withResolvers();
  const timeoutMs = options.timeoutMs ?? null;
  const timer = timeoutMs !== null && timeoutMs > 0 ? setTimeout(() => stop("timeout"), timeoutMs) : null;
  const onAbort = () => stop("cancelled");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const winner = await Promise.race([exited.then(() => "exit"), stopped]);
    if (winner === "exit") {
      const exited_at_ms = Date.now();
      const { code, signal } = await exited;
      const reclaimed2 = await reclaimProcessTree(
        { root_pid: child.pid, spawned_at_ms: child.started_at_ms, exited_at_ms },
        "exit cleanup"
      );
      return { outcome: code === 0 && signal === null ? "exited" : "crashed", exit_code: code, reclaimed: reclaimed2 };
    }
    const reclaimed = await reclaimProcessTree(
      { root_pid: child.pid, spawned_at_ms: child.started_at_ms },
      winner
    );
    await exited;
    return { outcome: winner, exit_code: null, reclaimed };
  } finally {
    if (timer !== null) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

// apps/agent-host/src/index.ts
function mapChildReport(payload) {
  let ok = false;
  let status = null;
  let errorCode2 = null;
  if (typeof payload === "object" && payload !== null) {
    if ("ok" in payload) ok = payload.ok === true;
    if ("status" in payload) status = payload.status;
    if ("error" in payload && typeof payload.error === "object" && payload.error !== null && "code" in payload.error) {
      errorCode2 = payload.error.code;
    }
  }
  if (ok && status === "succeeded") return { status: "succeeded", error_code: null };
  return {
    status: "failed",
    error_code: typeof errorCode2 === "string" ? errorCode2 : "provider_reported_failure"
  };
}
var HostSession = class {
  #registry;
  #input;
  #output;
  #logs;
  #spawnPolicy;
  #childSpec;
  #runTimeoutMs;
  #dispatch;
  #requests = new RequestIdTracker();
  #runs = /* @__PURE__ */ new Map();
  #active = /* @__PURE__ */ new Map();
  #handshaken = false;
  #closed = false;
  constructor(options) {
    this.#registry = options.registry;
    this.#input = options.input;
    this.#output = options.output;
    this.#logs = options.logs;
    this.#spawnPolicy = options.spawnPolicy;
    this.#childSpec = options.childSpec;
    this.#runTimeoutMs = options.runTimeoutMs ?? null;
    this.#dispatch = options.dispatch;
  }
  log(message) {
    this.#logs.write(`[host] ${redactText(message)}
`);
  }
  getRunState(run_id) {
    return this.#runs.get(run_id);
  }
  async waitForRuns() {
    while (this.#active.size > 0) {
      await Promise.all([...this.#active.values()].map((active) => active.done));
    }
  }
  async close() {
    this.#closed = true;
    for (const active of this.#active.values()) active.abort.abort("cancelled");
    await this.waitForRuns();
  }
  async handleParentLine(line) {
    const envelope = parseEnvelope(line);
    if (!this.#handshaken) {
      if (envelope.kind !== "request" || envelope.method !== "probe") {
        throw new ProtocolError("handshake_expected_probe", "the first message must be a probe request with protocol_version=1");
      }
      this.#handshaken = true;
      this.log("startup handshake accepted (protocol_version=1)");
    }
    if (envelope.kind !== "request") {
      throw new ProtocolError("unexpected_envelope", `the host only accepts requests from its parent, got kind ${envelope.kind}`);
    }
    try {
      this.#requests.track(envelope.id);
    } catch (error) {
      if (error instanceof ProtocolError && error.code === "duplicate_request_id") {
        this.log(`rejected duplicate request id ${envelope.id}`);
        this.#writeResponse(envelope.id, envelope.method, {
          ok: false,
          error: { code: "duplicate_request_id", message: redactText(error.message) }
        });
        return;
      }
      throw error;
    }
    switch (envelope.method) {
      case "probe": {
        const profiles = await this.#registry.probeAll();
        this.log(`probe answered with ${profiles.length} profile(s)`);
        this.#writeResponse(envelope.id, "probe", { ok: true, profiles });
        return;
      }
      case "start_run":
        this.#launchRun(envelope);
        return;
      case "cancel_run": {
        const payload = envelope.payload;
        let requested;
        if (typeof payload === "object" && payload !== null && "run_id" in payload) requested = payload.run_id;
        if (typeof requested !== "string" || requested.length === 0) {
          throw new ProtocolError("invalid_payload", "cancel_run requires a run_id");
        }
        const run_id = requested;
        const known = this.#runs.get(run_id);
        const active = this.#active.get(run_id);
        if (active) active.abort.abort("cancelled");
        if (!known && !active) {
          this.#writeResponse(envelope.id, "cancel_run", { ok: false, run_id, error: { code: "unknown_run" } });
          return;
        }
        this.#writeResponse(envelope.id, "cancel_run", { ok: true, run_id, status: active ? "cancelled" : known?.status });
        return;
      }
      case "shutdown": {
        await this.close();
        this.#writeResponse(envelope.id, "shutdown", { ok: true, status: "shutdown" });
        return;
      }
      default:
        throw new ProtocolError("unknown_method", String(envelope.method));
    }
  }
  async run() {
    const framer = new NdjsonFramer();
    try {
      for await (const chunk of this.#input) {
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        for (const line of framer.push(text)) {
          await this.handleParentLine(line);
          if (this.#closed) return;
        }
      }
      framer.flush();
    } catch (error) {
      this.log(`host protocol failure: ${error instanceof Error ? error.message : String(error)}`);
      await this.close();
      throw error;
    }
    await this.waitForRuns();
  }
  #writeEnvelope(envelope) {
    this.#output.write(`${serializeEnvelope(envelope)}
`);
  }
  #writeResponse(id, method, payload) {
    this.#writeEnvelope({ protocol_version: PROTOCOL_VERSION, id, kind: "response", method, payload: redactValue(payload) });
  }
  #launchRun(envelope) {
    const payload = envelope.payload;
    let requestedId;
    let request;
    if (typeof payload === "object" && payload !== null) {
      if ("run_id" in payload) requestedId = payload.run_id;
      if ("request" in payload) request = payload.request;
    }
    const run_id = requestedId;
    if (typeof run_id !== "string" || run_id.length === 0 || run_id.length > 128) {
      throw new ProtocolError("invalid_payload", "start_run requires a run_id");
    }
    if (this.#runs.has(run_id)) {
      throw new ProtocolError("duplicate_run", `run ${run_id} already exists`);
    }
    const state = { run_id, request_id: envelope.id, status: "running", attempts: 1, error_code: null };
    this.#runs.set(run_id, state);
    if (this.#dispatch) {
      const abort2 = new AbortController();
      const done2 = this.#driveAdapter(state, abort2, payload).finally(() => this.#active.delete(run_id));
      this.#active.set(run_id, { abort: abort2, done: done2 });
      return;
    }
    const spec = typeof this.#childSpec === "function" ? this.#childSpec(run_id, payload) : this.#childSpec;
    let child;
    try {
      if (!spec) throw new SpawnPolicyError("needs_configuration", "no provider dispatch configured");
      child = spawnChild(spec, this.#spawnPolicy);
    } catch (error) {
      state.status = "failed";
      state.error_code = error instanceof SpawnPolicyError ? error.code : "spawn_failed";
      this.#writeResponse(envelope.id, "start_run", {
        ok: false,
        run_id,
        status: state.status,
        error: { code: state.error_code, message: redactText(String(error)) }
      });
      return;
    }
    this.log(`run ${run_id} spawned provider child pid=${child.pid}`);
    const abort = new AbortController();
    const done = this.#driveRun(state, child, abort, request).finally(() => this.#active.delete(run_id));
    this.#active.set(run_id, { abort, done: done.catch((error) => this.log(`run ${run_id} driver error: ${String(error)}`)) });
  }
  async #driveAdapter(state, abort, payload) {
    const timer = this.#runTimeoutMs === null ? null : setTimeout(() => abort.abort("timeout"), this.#runTimeoutMs);
    try {
      for await (const event of this.#dispatch(payload, abort.signal)) {
        if (abort.signal.aborted) break;
        if (event.run_id !== state.run_id) throw new ProtocolError("invalid_payload", "adapter event run mismatch");
        this.#writeEnvelope({ protocol_version: PROTOCOL_VERSION, id: state.run_id + ":" + event.seq, kind: "event", method: "run_event", payload: event });
        if (event.type === "succeeded") state.status = "succeeded";
        if (event.type === "failed") {
          state.status = "failed";
          state.error_code = typeof event.data?.error_code === "string" ? event.data.error_code : "provider_reported_failure";
        }
        if (event.type === "cancelled") state.status = "cancelled";
      }
      if (abort.signal.aborted) {
        state.status = abort.signal.reason === "timeout" ? "timeout" : "cancelled";
        state.error_code = state.status === "timeout" ? "run_timeout" : null;
      }
      if (state.status === "running") {
        state.status = "failed";
        state.error_code = "missing_terminal_response";
      }
    } catch (error) {
      state.status = abort.signal.aborted ? abort.signal.reason === "timeout" ? "timeout" : "cancelled" : "failed";
      state.error_code = error instanceof Error && "code" in error ? String(error.code) : "adapter_error";
    } finally {
      if (timer !== null) clearTimeout(timer);
      this.#writeResponse(state.request_id, "start_run", { ok: state.status === "succeeded", run_id: state.run_id, status: state.status, ...state.error_code ? { error: { code: state.error_code } } : {} });
    }
  }
  async #driveRun(state, child, abort, request) {
    const holder = { report: null, failure: null };
    const reader = (async () => {
      const framer = new NdjsonFramer();
      for await (const chunk of child.stdout) {
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        for (const line of framer.push(text)) {
          const envelope = parseEnvelope(line);
          if (envelope.kind === "event") {
            this.#writeEnvelope({ protocol_version: PROTOCOL_VERSION, id: envelope.id, kind: "event", method: "run_event", payload: redactValue(envelope.payload) });
          } else if (envelope.kind === "response") {
            holder.report = mapChildReport(envelope.payload);
            child.stdin.end();
          } else {
            this.log(`dropped unexpected ${envelope.kind} envelope from provider child`);
          }
        }
      }
      framer.flush();
    })();
    const settled = reader.catch((error) => {
      if (error instanceof ProtocolError) holder.failure = error;
      else this.log(`provider child stream error: ${String(error)}`);
      abort.abort("protocol_error");
    });
    let stderrRest = "";
    const stderrLog = (async () => {
      for await (const chunk of child.stderr) {
        stderrRest += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        const lines = stderrRest.split("\n");
        stderrRest = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim() !== "") this.log(`provider[pid ${child.pid}]: ${line}`);
        }
      }
      if (stderrRest.trim() !== "") this.log(`provider[pid ${child.pid}]: ${stderrRest}`);
    })();
    const childRequest = {
      protocol_version: PROTOCOL_VERSION,
      id: state.run_id,
      kind: "request",
      method: "start_run",
      // The provider child must receive the run request verbatim: it is billed
      // input. Redaction is for logs and host->parent output only; provider
      // credentials reach the child through env allowlists and secret refs.
      payload: { run_id: state.run_id, request }
    };
    child.stdin.on("error", (error) => {
      this.log(`provider child stdin error: ${String(error)}`);
    });
    try {
      child.stdin.write(`${serializeEnvelope(childRequest)}
`);
    } catch (error) {
      this.log(`provider child stdin write failed: ${String(error)}`);
    }
    let supervised = null;
    let supervision_code = null;
    try {
      supervised = await superviseChild(child, { timeoutMs: this.#runTimeoutMs, signal: abort.signal });
      await settled;
      await stderrLog;
    } catch (error) {
      supervision_code = error instanceof SpawnPolicyError ? error.code : "supervision_failed";
      this.log(`run ${state.run_id} supervision failure: ${String(error)}`);
    }
    let status;
    let error_code = null;
    if (supervision_code !== null) {
      status = "failed";
      error_code = supervision_code;
    } else if (holder.failure !== null) {
      status = "failed";
      error_code = holder.failure.code;
    } else if (supervised?.outcome === "timeout") {
      status = "timeout";
      error_code = "run_timeout";
    } else if (supervised?.outcome === "cancelled") {
      status = "cancelled";
    } else if (supervised?.outcome === "crashed") {
      status = "failed";
      error_code = "child_crashed";
    } else if (holder.report !== null) {
      status = holder.report.status;
      error_code = holder.report.error_code;
    } else {
      status = "failed";
      error_code = "missing_terminal_response";
    }
    state.status = status;
    state.error_code = error_code;
    this.#writeResponse(state.request_id, "start_run", {
      ok: status === "succeeded",
      run_id: state.run_id,
      status,
      ...error_code === null ? {} : { error: { code: error_code, message: `run finished with status ${status}` } }
    });
    this.log(
      `run ${state.run_id} finished status=${status} outcome=${supervised?.outcome ?? "supervision_error"} reclaim_mechanism=${supervised?.reclaimed.mechanism ?? "none"}`
    );
  }
};

// apps/agent-host/src/registry.ts
var RegistryError = class extends Error {
  code;
  constructor(code, detail) {
    super(detail === void 0 ? code : `${code}: ${detail}`);
    this.name = "RegistryError";
    this.code = code;
  }
};
var AVAILABILITY = {
  ready: true,
  needs_login: true,
  needs_configuration: true,
  unsupported: true,
  blocked: true
};
var VERIFICATION = {
  not_run: true,
  mock_only: true,
  live_passed: true,
  live_failed: true
};
function assertProfileShape(key, profile) {
  if (typeof profile !== "object" || profile === null) {
    throw new RegistryError("invalid_model_profile", `${key} probe() returned a non-object profile`);
  }
  if (typeof profile.profile_id !== "string" || profile.profile_id.length === 0) {
    throw new RegistryError("invalid_model_profile", `${key} profile is missing profile_id`);
  }
  if (typeof profile.model_id !== "string" || profile.model_id.length === 0) {
    throw new RegistryError("invalid_model_profile", `${key} profile is missing model_id`);
  }
  if (AVAILABILITY[profile.availability] !== true) {
    throw new RegistryError("invalid_model_profile", `${key} profile has availability ${JSON.stringify(profile.availability)}`);
  }
  if (VERIFICATION[profile.verification] !== true) {
    throw new RegistryError("invalid_model_profile", `${key} profile has verification ${JSON.stringify(profile.verification)}`);
  }
}
var ProviderRegistry = class {
  #adapters = /* @__PURE__ */ new Map();
  async resolve(profile_id) {
    let match;
    for (const [key, entry] of this.#adapters) {
      for (const profile of await entry.adapter.probe()) {
        assertProfileShape(key, profile);
        if (entry.mock && (profile.provider_id !== "mock" || profile.verification !== "mock_only")) throw new RegistryError("mock_registration_misclaim");
        if (profile.profile_id !== profile_id) continue;
        if (match) throw new RegistryError("ambiguous_profile");
        match = { adapter: entry.adapter, profile };
      }
    }
    if (!match) throw new RegistryError("unknown_model");
    if (match.profile.availability !== "ready") throw new RegistryError(match.profile.availability);
    return match;
  }
  register(key, adapter, options = {}) {
    if (typeof key !== "string" || key.length === 0) {
      throw new RegistryError("invalid_provider_key", "registry keys must be non-empty strings");
    }
    if (this.#adapters.has(key)) {
      throw new RegistryError("already_registered", key);
    }
    if (typeof adapter?.probe !== "function" || typeof adapter?.run !== "function") {
      throw new RegistryError("invalid_adapter", `${key} must implement probe() and run()`);
    }
    this.#adapters.set(key, { adapter, mock: options.mock === true });
  }
  keys() {
    return [...this.#adapters.keys()];
  }
  async probeAll() {
    const profiles = [];
    for (const [key, entry] of this.#adapters) {
      const produced = await entry.adapter.probe();
      if (!Array.isArray(produced)) {
        throw new RegistryError("invalid_model_profile", `${key} probe() must return an array`);
      }
      for (const profile of produced) {
        assertProfileShape(key, profile);
        if (entry.mock && (profile.provider_id !== "mock" || profile.verification !== "mock_only")) {
          throw new RegistryError(
            "mock_registration_misclaim",
            `${key}: mock registrations may only claim provider_id "mock" with verification "mock_only"`
          );
        }
        profiles.push(profile);
      }
    }
    return profiles;
  }
};

// apps/agent-host/src/runtime/context.ts
var ServerRuntimeContext = class _ServerRuntimeContext {
  constructor(binding, facts, signal) {
    this.binding = binding;
    this.facts = facts;
    this.signal = signal;
    this.run_id = binding.run_id;
    this.approved_grant_ids = facts.approved_grant_ids;
    this.approved_image_region = facts.approved_image_region;
    this.allow_image = facts.allow_image;
    this.allow_object_context = facts.allow_object_context;
  }
  run_id;
  approved_grant_ids;
  approved_image_region;
  allow_image;
  allow_object_context;
  static async open(binding, signal) {
    const facts = await callTool(binding, signal, "get_context", {});
    if (facts.run_id !== binding.run_id || typeof facts.allow_image !== "boolean" || typeof facts.allow_object_context !== "boolean" || !Array.isArray(facts.approved_grant_ids)) throw new RegistryError("invalid_runtime_context");
    return new _ServerRuntimeContext(binding, facts, signal);
  }
  async read_region(grant_id, region) {
    if (!this.allow_image || !this.approved_grant_ids.includes(grant_id)) throw new RegistryError("image_grant_missing");
    const result = await callTool(this.binding, this.signal, "read_region", { region });
    if (result.mime !== "image/png" || typeof result.data_base64 !== "string") throw new RegistryError("invalid_region");
    return { bytes: Buffer.from(result.data_base64, "base64"), mime: result.mime, transform_to_canonical: result.transform_to_canonical };
  }
  async get_document() {
    const objects = [];
    let cursor = null;
    if (this.allow_object_context) {
      const seen = /* @__PURE__ */ new Set();
      do {
        const page = await callTool(this.binding, this.signal, "list_objects", { limit: 100, ...cursor ? { cursor } : {} });
        for (const item of page.items) objects.push(item.object);
        if (objects.length > 1e4 || page.next_cursor && seen.has(page.next_cursor)) throw new RegistryError("object_budget_exceeded");
        cursor = page.next_cursor;
        if (cursor) seen.add(cursor);
      } while (cursor);
    }
    return { schema_version: 1, asset_revision_id: this.binding.request.context.asset_revision_id, ontology_version_id: this.binding.request.context.ontology_version_id, coordinate_space: { type: "canonical_image_pixels", width: this.facts.media.width, height: this.facts.media.height }, completion: "unprocessed", objects };
  }
  async get_ontology() {
    const facts = await callTool(this.binding, this.signal, "get_context", {});
    return facts.ontology;
  }
  async submit_candidates(candidate) {
    const draft = candidate;
    const result = await callTool(this.binding, this.signal, "propose_changes", draft);
    return { ...draft, ...result, model_run_id: this.run_id, context: this.binding.request.context };
  }
  async report_issues(issues) {
    await callTool(this.binding, this.signal, "report_issues", { issues });
  }
};
async function callTool(binding, signal, tool, args) {
  const base = new URL(binding.apiBase);
  if (base.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new RegistryError("api_base_untrusted");
  const response = await fetch(`${base.origin}/internal/agent-tools/${tool}`, { method: "POST", headers: { authorization: `Bearer ${binding.token}`, "content-type": "application/json" }, body: JSON.stringify(args), signal: AbortSignal.any([signal, AbortSignal.timeout(15e3)]), redirect: "error" });
  const reader = response.body?.getReader();
  if (!reader) throw new RegistryError("tool_output_missing");
  let size = 0;
  const chunks = [];
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16 * 1024 * 1024) throw new RegistryError("tool_output_too_large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!response.ok) throw new RegistryError(typeof result.code === "string" ? result.code : "agent_tools_rejected");
  return result;
}

// packages/contracts/generated/suggestion_set.schema.json
var suggestion_set_schema_default = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "SuggestionSet",
  type: "object",
  required: [
    "changes",
    "context",
    "issues",
    "model_run_id",
    "prediction_id",
    "score",
    "state",
    "suggestion_set_id"
  ],
  properties: {
    changes: {
      type: "array",
      items: {
        $ref: "#/definitions/Change"
      }
    },
    context: {
      $ref: "#/definitions/RunContext"
    },
    issues: {
      type: "array",
      items: {
        $ref: "#/definitions/QualityIssue"
      }
    },
    model_run_id: {
      $ref: "#/definitions/Id"
    },
    prediction_id: {
      $ref: "#/definitions/Id"
    },
    score: {
      anyOf: [
        {
          type: "number",
          format: "double"
        },
        {
          type: "null"
        }
      ]
    },
    state: {
      $ref: "#/definitions/SuggestionState"
    },
    suggestion_set_id: {
      $ref: "#/definitions/Id"
    }
  },
  additionalProperties: false,
  definitions: {
    AnnotationObject: {
      type: "object",
      required: [
        "attributes",
        "geometry",
        "label_id",
        "object_id",
        "origin"
      ],
      properties: {
        attributes: {
          $ref: "#/definitions/AttributeMap"
        },
        geometry: {
          $ref: "#/definitions/BBox"
        },
        label_id: {
          $ref: "#/definitions/Id"
        },
        object_id: {
          $ref: "#/definitions/Id"
        },
        origin: {
          $ref: "#/definitions/Origin"
        }
      },
      additionalProperties: false
    },
    AttributeMap: {
      type: "object",
      additionalProperties: {
        $ref: "#/definitions/Scalar"
      },
      propertyNames: {
        type: "string",
        maxLength: 128,
        minLength: 1
      }
    },
    BBox: {
      type: "object",
      required: [
        "type",
        "x_max",
        "x_min",
        "y_max",
        "y_min"
      ],
      properties: {
        type: {
          $ref: "#/definitions/BBoxType"
        },
        x_max: {
          type: "number",
          format: "double"
        },
        x_min: {
          type: "number",
          format: "double"
        },
        y_max: {
          type: "number",
          format: "double"
        },
        y_min: {
          type: "number",
          format: "double"
        }
      },
      additionalProperties: false
    },
    BBoxType: {
      type: "string",
      enum: [
        "bbox_xyxy"
      ]
    },
    Change: {
      oneOf: [
        {
          type: "object",
          required: [
            "before_hash",
            "change_id",
            "kind",
            "object",
            "reason"
          ],
          properties: {
            before_hash: {
              anyOf: [
                {
                  type: "string"
                },
                {
                  type: "null"
                }
              ]
            },
            change_id: {
              $ref: "#/definitions/Id"
            },
            kind: {
              type: "string",
              enum: [
                "create"
              ]
            },
            object: {
              $ref: "#/definitions/AnnotationObject"
            },
            reason: {
              type: "string"
            }
          },
          additionalProperties: false
        },
        {
          type: "object",
          required: [
            "before_hash",
            "change_id",
            "kind",
            "object_id",
            "reason",
            "values"
          ],
          properties: {
            before_hash: {
              type: "string"
            },
            change_id: {
              $ref: "#/definitions/Id"
            },
            kind: {
              type: "string",
              enum: [
                "set_attributes"
              ]
            },
            object_id: {
              $ref: "#/definitions/Id"
            },
            reason: {
              type: "string"
            },
            values: {
              $ref: "#/definitions/AttributeMap"
            }
          },
          additionalProperties: false
        },
        {
          type: "object",
          required: [
            "before_hash",
            "change_id",
            "kind",
            "label_id",
            "object_id",
            "reason"
          ],
          properties: {
            before_hash: {
              type: "string"
            },
            change_id: {
              $ref: "#/definitions/Id"
            },
            kind: {
              type: "string",
              enum: [
                "set_label"
              ]
            },
            label_id: {
              $ref: "#/definitions/Id"
            },
            object_id: {
              $ref: "#/definitions/Id"
            },
            reason: {
              type: "string"
            }
          },
          additionalProperties: false
        }
      ]
    },
    Id: {
      type: "string",
      maxLength: 128,
      minLength: 1
    },
    Origin: {
      type: "object",
      required: [
        "import_batch_id",
        "model_run_id",
        "prediction_id",
        "type"
      ],
      properties: {
        import_batch_id: {
          anyOf: [
            {
              $ref: "#/definitions/Id"
            },
            {
              type: "null"
            }
          ]
        },
        model_run_id: {
          anyOf: [
            {
              $ref: "#/definitions/Id"
            },
            {
              type: "null"
            }
          ]
        },
        prediction_id: {
          anyOf: [
            {
              $ref: "#/definitions/Id"
            },
            {
              type: "null"
            }
          ]
        },
        type: {
          $ref: "#/definitions/OriginType"
        }
      },
      additionalProperties: false
    },
    OriginType: {
      type: "string",
      enum: [
        "manual",
        "import",
        "prediction"
      ]
    },
    QualityIssue: {
      type: "object",
      required: [
        "code",
        "issue_id",
        "message",
        "object_id",
        "region"
      ],
      properties: {
        code: {
          type: "string"
        },
        issue_id: {
          $ref: "#/definitions/Id"
        },
        message: {
          type: "string"
        },
        object_id: {
          anyOf: [
            {
              $ref: "#/definitions/Id"
            },
            {
              type: "null"
            }
          ]
        },
        region: {
          anyOf: [
            {
              $ref: "#/definitions/BBox"
            },
            {
              type: "null"
            }
          ]
        }
      },
      additionalProperties: false
    },
    RunContext: {
      type: "object",
      required: [
        "annotation_revision_id",
        "asset_revision_id",
        "canonical_sha256",
        "draft_generation",
        "input_fingerprint",
        "object_hashes",
        "ontology_version_id",
        "project_id",
        "selected_object_ids"
      ],
      properties: {
        annotation_revision_id: {
          $ref: "#/definitions/Id"
        },
        asset_revision_id: {
          $ref: "#/definitions/Id"
        },
        canonical_sha256: {
          type: "string"
        },
        draft_generation: {
          type: "integer",
          format: "uint64",
          maximum: 9007199254740991,
          minimum: 0
        },
        input_fingerprint: {
          type: "string"
        },
        object_hashes: {
          type: "object",
          additionalProperties: {
            type: "string"
          }
        },
        ontology_version_id: {
          $ref: "#/definitions/Id"
        },
        project_id: {
          $ref: "#/definitions/Id"
        },
        selected_object_ids: {
          type: "array",
          items: {
            $ref: "#/definitions/Id"
          }
        }
      },
      additionalProperties: false
    },
    Scalar: {
      anyOf: [
        {
          type: "string",
          maxLength: 4096
        },
        {
          type: "boolean"
        },
        {
          type: "number",
          format: "double"
        },
        {
          type: "null"
        }
      ]
    },
    SuggestionState: {
      type: "string",
      enum: [
        "pending",
        "stale",
        "rejected",
        "partially_accepted",
        "accepted"
      ]
    }
  }
};

// apps/agent-host/src/providers/http/errors.ts
var ProviderError = class extends Error {
  code;
  status;
  constructor(code, detail, status = null) {
    super(detail === void 0 ? code : `${code}: ${redactText(detail)}`);
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
  }
};
function mapHttpStatus(status, detail) {
  if (status === 401) return new ProviderError("unauthorized_401", detail, status);
  if (status === 403) return new ProviderError("forbidden_403", detail, status);
  if (status === 429) return new ProviderError("rate_limited_429", detail, status);
  if (status >= 500) return new ProviderError("upstream_5xx", detail, status);
  return new ProviderError("request_rejected_4xx", detail, status);
}
function decodeJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ProviderError("invalid_json", error instanceof Error ? error.message : "unparseable JSON");
  }
}
var MAX_ID_LENGTH2 = 128;
var MAX_TEXT_LENGTH = 4096;
var MAX_REASON_LENGTH = 2048;
var MAX_CHANGES = 256;
var MAX_ISSUES = 256;
function invalid(detail) {
  return new ProviderError("candidate_invalid", detail);
}
function requireObject(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${path} must be an object`);
  return value;
}
function requireId(value, path) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH2) {
    throw invalid(`${path} must be a non-empty id of at most ${MAX_ID_LENGTH2} characters`);
  }
  return value;
}
function requireText(value, path, max) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw invalid(`${path} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}
function requireFinite(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(`${path} must be a finite number`);
  return value;
}
function assertExactKeys(record, allowed, path) {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw invalid(`${path} has unknown field ${JSON.stringify(key)}`);
  }
}
function requireBBox(value, path, document) {
  const record = requireObject(value, path);
  assertExactKeys(record, ["type", "x_min", "y_min", "x_max", "y_max"], path);
  if (record.type !== "bbox_xyxy") throw invalid(`${path}.type must be "bbox_xyxy"`);
  const x_min = requireFinite(record.x_min, `${path}.x_min`);
  const y_min = requireFinite(record.y_min, `${path}.y_min`);
  const x_max = requireFinite(record.x_max, `${path}.x_max`);
  const y_max = requireFinite(record.y_max, `${path}.y_max`);
  if (x_min >= x_max || y_min >= y_max) throw invalid(`${path} must have positive extent`);
  const { width, height } = document.coordinate_space;
  if (x_min < 0 || y_min < 0 || x_max > width || y_max > height) {
    throw invalid(`${path} escapes the canonical image (${width}x${height})`);
  }
  return { type: "bbox_xyxy", x_min, y_min, x_max, y_max };
}
function requireScalar(value, path) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return requireFinite(value, path);
  if (typeof value === "string") {
    if (value.length > MAX_TEXT_LENGTH) throw invalid(`${path} string exceeds ${MAX_TEXT_LENGTH} characters`);
    return value;
  }
  throw invalid(`${path} must be a scalar (string, boolean, finite number or null)`);
}
function requireAttributes(value, path, defs, requireAll) {
  const record = requireObject(value, path);
  const values = {};
  for (const [key, item] of Object.entries(record)) {
    const def = defs.find((candidate) => candidate.key === key);
    if (def === void 0) throw invalid(`${path}.${key} is not an attribute of the target label`);
    const scalar = requireScalar(item, `${path}.${key}`);
    if (def.kind === "boolean" && typeof scalar !== "boolean") throw invalid(`${path}.${key} must be a boolean`);
    if (def.kind === "number" && typeof scalar !== "number") throw invalid(`${path}.${key} must be a number`);
    if (def.kind === "text" && typeof scalar !== "string") throw invalid(`${path}.${key} must be text`);
    if (def.kind === "enum" && (typeof scalar !== "string" || !def.enum_values.includes(scalar))) {
      throw invalid(`${path}.${key} must be one of ${def.enum_values.join(", ")}`);
    }
    if (typeof scalar === "number") {
      if (def.min !== null && scalar < def.min) throw invalid(`${path}.${key} is below the minimum`);
      if (def.max !== null && scalar > def.max) throw invalid(`${path}.${key} is above the maximum`);
    }
    values[key] = scalar;
  }
  if (requireAll) {
    for (const def of defs) {
      if (def.required && !(def.key in values)) throw invalid(`${path}.${def.key} is required by the ontology`);
    }
  }
  return values;
}
function labelOf(ontology, label_id, path) {
  const label = ontology.labels.find((candidate) => candidate.label_id === label_id);
  if (label === void 0) throw invalid(`${path} references unknown label ${JSON.stringify(label_id)}`);
  return label;
}
function objectOf(document, object_id, path) {
  const object = document.objects.find((candidate) => candidate.object_id === object_id);
  if (object === void 0) throw invalid(`${path} references unknown object ${JSON.stringify(object_id)}`);
  return object;
}
function requireBeforeHash(value, path) {
  return requireText(value, path, MAX_ID_LENGTH2);
}
function validateCreateObject(value, path, ctx) {
  const record = requireObject(value, path);
  assertExactKeys(record, ["object_id", "label_id", "geometry", "attributes", "origin"], path);
  const object_id = requireId(record.object_id, `${path}.object_id`);
  const label_id = requireId(record.label_id, `${path}.label_id`);
  const label = labelOf(ctx.ontology, label_id, `${path}.label_id`);
  const geometry = requireBBox(record.geometry, `${path}.geometry`, ctx.document);
  const attributes = requireAttributes(record.attributes, `${path}.attributes`, label.attributes, true);
  const origin = requireObject(record.origin, `${path}.origin`);
  assertExactKeys(origin, ["type", "prediction_id", "model_run_id", "import_batch_id"], path);
  if (origin.type !== "prediction") throw invalid(`${path}.origin.type must be "prediction" for model output`);
  if (origin.prediction_id !== null || origin.model_run_id !== null || origin.import_batch_id !== null) {
    throw invalid(`${path}.origin ids are assigned by the server and must be null`);
  }
  return {
    object_id,
    label_id,
    geometry,
    attributes,
    origin: { type: "prediction", prediction_id: null, model_run_id: null, import_batch_id: null }
  };
}
function validateChange(value, path, ctx, seen) {
  const record = requireObject(value, path);
  const kind = record.kind;
  const change_id = requireId(record.change_id, `${path}.change_id`);
  if (seen.has(change_id)) throw invalid(`${path}.change_id ${JSON.stringify(change_id)} is duplicated`);
  seen.add(change_id);
  const reason = requireText(record.reason, `${path}.reason`, MAX_REASON_LENGTH);
  if (kind === "create") {
    assertExactKeys(record, ["kind", "change_id", "object", "before_hash", "reason"], path);
    if (ctx.intent !== "detect" || !ctx.bbox_output) {
      throw invalid(`${path}: create changes are only allowed for a bbox-capable detect run`);
    }
    if (record.before_hash !== null) throw invalid(`${path}.before_hash must be null for create`);
    return { kind: "create", change_id, object: validateCreateObject(record.object, `${path}.object`, ctx), before_hash: null, reason };
  }
  if (kind === "set_attributes") {
    assertExactKeys(record, ["kind", "change_id", "object_id", "values", "before_hash", "reason"], path);
    const object_id = requireId(record.object_id, `${path}.object_id`);
    const object = objectOf(ctx.document, object_id, `${path}.object_id`);
    const label = labelOf(ctx.ontology, object.label_id, `${path}.object_id`);
    return {
      kind: "set_attributes",
      change_id,
      object_id,
      values: requireAttributes(record.values, `${path}.values`, label.attributes, false),
      before_hash: requireBeforeHash(record.before_hash, `${path}.before_hash`),
      reason
    };
  }
  if (kind === "set_label") {
    assertExactKeys(record, ["kind", "change_id", "object_id", "label_id", "before_hash", "reason"], path);
    const object_id = requireId(record.object_id, `${path}.object_id`);
    objectOf(ctx.document, object_id, `${path}.object_id`);
    const label_id = requireId(record.label_id, `${path}.label_id`);
    labelOf(ctx.ontology, label_id, `${path}.label_id`);
    return {
      kind: "set_label",
      change_id,
      object_id,
      label_id,
      before_hash: requireBeforeHash(record.before_hash, `${path}.before_hash`),
      reason
    };
  }
  throw invalid(`${path}.kind must be create, set_attributes or set_label`);
}
function validateIssue(value, path, ctx) {
  const record = requireObject(value, path);
  assertExactKeys(record, ["issue_id", "object_id", "code", "message", "region"], path);
  const issue_id = requireId(record.issue_id, `${path}.issue_id`);
  let object_id = null;
  if (record.object_id !== null) {
    object_id = requireId(record.object_id, `${path}.object_id`);
    objectOf(ctx.document, object_id, `${path}.object_id`);
  }
  const code = requireText(record.code, `${path}.code`, MAX_ID_LENGTH2);
  const message = requireText(record.message, `${path}.message`, MAX_TEXT_LENGTH);
  const region = record.region === null ? null : requireBBox(record.region, `${path}.region`, ctx.document);
  return { issue_id, object_id, code, message, region };
}
function validateQualityIssues(input, ctx) {
  if (!Array.isArray(input)) throw invalid("issues must be an array");
  if (input.length > MAX_ISSUES) throw invalid(`issues exceeds ${MAX_ISSUES} entries`);
  const seen = /* @__PURE__ */ new Set();
  return input.map((value, index) => {
    const issue = validateIssue(value, `issues[${index}]`, ctx);
    if (seen.has(issue.issue_id)) throw invalid(`issues[${index}].issue_id ${JSON.stringify(issue.issue_id)} is duplicated`);
    seen.add(issue.issue_id);
    return issue;
  });
}
function validateCandidateDraft(input, ctx) {
  const record = requireObject(input, "candidate");
  assertExactKeys(record, ["changes", "issues", "score"], "candidate");
  if (!("changes" in record)) throw invalid("candidate.changes is required");
  if (!Array.isArray(record.changes)) throw invalid("candidate.changes must be an array");
  if (record.changes.length > MAX_CHANGES) throw invalid(`candidate.changes exceeds ${MAX_CHANGES} entries`);
  const seen = /* @__PURE__ */ new Set();
  const changes = record.changes.map((value, index) => validateChange(value, `changes[${index}]`, ctx, seen));
  const issues = "issues" in record ? validateQualityIssues(record.issues, ctx) : [];
  let score = null;
  if ("score" in record && record.score !== null) score = requireFinite(record.score, "candidate.score");
  return { changes, issues, score };
}
function invalidTool(detail) {
  return new ProviderError("invalid_tool_call", detail);
}
function parseToolCallArguments(name, raw, ctx) {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw invalidTool(`${name} arguments are not valid JSON: ${error instanceof Error ? error.message : "unparseable"}`);
    }
  }
  if (name === "read_region") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidTool("read_region arguments must be an object");
    const record = value;
    assertToolKeys(record, ["region"], "read_region");
    if (!("region" in record)) throw invalidTool("read_region.region is required");
    return { tool: "read_region", region: requireToolBBox(record.region, ctx) };
  }
  if (name === "propose_changes") {
    return { tool: "propose_changes", draft: validateCandidateDraft(value, ctx) };
  }
  if (name === "report_issues") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidTool("report_issues arguments must be an object");
    const record = value;
    assertToolKeys(record, ["issues"], "report_issues");
    if (!("issues" in record)) throw invalidTool("report_issues.issues is required");
    return { tool: "report_issues", issues: validateQualityIssues(record.issues, ctx) };
  }
  throw invalidTool(`unknown tool ${JSON.stringify(name)}`);
}
function assertToolKeys(record, allowed, name) {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw invalidTool(`${name} arguments have unknown field ${JSON.stringify(key)}`);
  }
}
function requireToolBBox(value, ctx) {
  if (value === null) return null;
  try {
    return requireBBox(value, "read_region.region", ctx.document);
  } catch (error) {
    if (error instanceof ProviderError) throw invalidTool(error.message);
    throw error;
  }
}

// apps/agent-host/src/providers/http/client.ts
var OFFICIAL_API_BASES = {
  openai_api: "https://api.openai.com/v1",
  anthropic_api: "https://api.anthropic.com",
  mimo_api: "https://api.xiaomimimo.com/v1"
};
var REDIRECT_STATUSES = { 301: true, 302: true, 303: true, 307: true, 308: true };
var PRIVATE_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".corp"];
function hostIsPrivate(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  for (const suffix of PRIVATE_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) return true;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4 !== null) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if ([a, b, Number(ipv4[3]), Number(ipv4[4])].some((part) => part > 255)) return true;
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127;
  }
  if (host.includes(":")) {
    if (host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true;
    const mapped = host.match(/^(?:::ffff:|::)(.+)$/);
    if (mapped !== null) {
      const rest = mapped[1];
      const dottedTail = rest.match(/(?:^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
      if (dottedTail !== null) return hostIsPrivate(dottedTail[1]);
      const groups = rest.split(":");
      if ((groups.length === 2 || groups.length === 3) && groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
        const hi = Number.parseInt(groups[groups.length - 2], 16);
        const lo = Number.parseInt(groups[groups.length - 1], 16);
        return hostIsPrivate(`${hi >> 8 & 255}.${hi & 255}.${lo >> 8 & 255}.${lo & 255}`);
      }
    }
    return false;
  }
  return false;
}
function normalizeBase(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError("base_not_approved", "api base must be an absolute URL");
  }
  if (url.username !== "" || url.password !== "") throw new ProviderError("base_not_approved", "api base must not carry credentials");
  if (url.search !== "" || url.hash !== "") throw new ProviderError("base_not_approved", "api base must not carry a query or fragment");
  return url;
}
function stripTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
function approvalIsValid(approval, local_admins) {
  return approval !== void 0 && approval.approved === true && typeof approval.approved_by === "string" && local_admins.includes(approval.approved_by) && typeof approval.approved_at === "string" && Number.isFinite(Date.parse(approval.approved_at));
}
function resolveBase(raw, provider_id, approval, local_admins) {
  const url = normalizeBase(raw);
  const base = stripTrailingSlash(url.toString().replace(/\/$/, ""));
  const official = OFFICIAL_API_BASES[provider_id];
  const isOfficial = stripTrailingSlash(raw) === official;
  if (!isOfficial && !approvalIsValid(approval, local_admins)) {
    throw new ProviderError("base_not_approved", "a non-official api base requires explicit approval by a trusted local admin");
  }
  const approved = approvalIsValid(approval, local_admins);
  if (url.protocol !== "https:" && !(approved && approval.allow_insecure_http === true)) {
    throw new ProviderError("ssrf_blocked", "api base must use https");
  }
  if (hostIsPrivate(url.hostname) && !(approved && approval.allow_private_network === true)) {
    throw new ProviderError("ssrf_blocked", "loopback and private-network destinations are refused");
  }
  return base;
}
var SseDecoder = class {
  #lineBuffer = "";
  #event = null;
  #data = [];
  push(text) {
    this.#lineBuffer += text;
    const frames = [];
    for (; ; ) {
      const index = this.#lineBuffer.indexOf("\n");
      if (index < 0) break;
      const raw = this.#lineBuffer.slice(0, index);
      this.#lineBuffer = this.#lineBuffer.slice(index + 1);
      const frame = this.#pushLine(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
      if (frame !== null) frames.push(frame);
    }
    return frames;
  }
  end() {
    if (this.#lineBuffer.length > 0 || this.#data.length > 0 || this.#event !== null) {
      throw new ProviderError("interrupted_stream", "stream ended before the current event was terminated");
    }
  }
  #pushLine(line) {
    if (line === "") {
      if (this.#data.length === 0) {
        this.#event = null;
        return null;
      }
      const frame = { event: this.#event, data: this.#data.join("\n") };
      this.#event = null;
      this.#data = [];
      return frame;
    }
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") this.#event = value;
    else if (field === "data") this.#data.push(value);
    return null;
  }
};
var BoundedHttpClient = class {
  #fetch;
  #timeout_ms;
  #max_response_bytes;
  #max_stream_bytes;
  #base_url;
  #base_error;
  constructor(options) {
    this.#fetch = options.fetch_impl ?? ((url, init) => globalThis.fetch(url, init));
    this.#timeout_ms = options.timeout_ms ?? 6e4;
    this.#max_response_bytes = options.max_response_bytes ?? 4 * 1024 * 1024;
    this.#max_stream_bytes = options.max_stream_bytes ?? 4 * 1024 * 1024;
    const local_admins = options.local_admins ?? [];
    const raw = options.api_base ?? OFFICIAL_API_BASES[options.provider_id];
    try {
      this.#base_url = resolveBase(raw, options.provider_id, options.base_approval, local_admins);
      this.#base_error = null;
    } catch (error) {
      this.#base_url = stripTrailingSlash(raw);
      this.#base_error = error instanceof ProviderError ? error : new ProviderError("base_not_approved", "unresolvable api base");
    }
  }
  get base_url() {
    return this.#base_url;
  }
  get base_error() {
    return this.#base_error;
  }
  resolveRequestUrl(path) {
    if (this.#base_error !== null) throw this.#base_error;
    if (typeof path !== "string" || !path.startsWith("/") || path.includes("//") || path.includes("\\") || path.split("/").includes("..")) {
      throw new ProviderError("base_not_approved", "request path escapes the approved api base");
    }
    return `${this.#base_url}${path}`;
  }
  async send(path, request, signal) {
    const url = this.resolveRequestUrl(path);
    const { controller, timer, detach } = this.#deadline(request.timeout_ms, signal);
    try {
      const res = await this.#post(url, request, controller.signal);
      if (REDIRECT_STATUSES[res.status] === true) {
        throw new ProviderError("redirect_rejected", `refusing to follow a ${res.status} redirect`, res.status);
      }
      const body_text = await readBodyCapped(res, this.#max_response_bytes);
      if (res.status < 200 || res.status >= 300) throw mapHttpStatus(res.status, body_text.slice(0, 200));
      return { status: res.status, body_text };
    } finally {
      clearTimeout(timer);
      detach();
    }
  }
  async *sendStream(path, request, signal) {
    const url = this.resolveRequestUrl(path);
    const { controller, timer, detach } = this.#deadline(request.timeout_ms, signal);
    try {
      const res = await this.#post(url, request, controller.signal);
      if (REDIRECT_STATUSES[res.status] === true) {
        throw new ProviderError("redirect_rejected", `refusing to follow a ${res.status} redirect`, res.status);
      }
      if (res.status < 200 || res.status >= 300) {
        const body_text = await readBodyCapped(res, this.#max_response_bytes);
        throw mapHttpStatus(res.status, body_text.slice(0, 200));
      }
      if (res.body === null) throw new ProviderError("interrupted_stream", "streaming response has no body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseDecoder();
      let total = 0;
      try {
        for (; ; ) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value === void 0) continue;
          total += value.byteLength;
          if (total > this.#max_stream_bytes) {
            await reader.cancel();
            throw new ProviderError("oversized_response", `stream exceeded ${this.#max_stream_bytes} bytes`);
          }
          for (const frame of parser.push(decoder.decode(value, { stream: true }))) yield frame;
        }
        for (const frame of parser.push(decoder.decode())) yield frame;
        parser.end();
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (controller.signal.aborted) throw new ProviderError("timeout", "stream aborted by timeout or cancellation");
        throw new ProviderError("interrupted_stream", error instanceof Error ? error.message : "stream failure");
      }
    } finally {
      clearTimeout(timer);
      detach();
    }
  }
  #deadline(timeout_ms, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout_ms ?? this.#timeout_ms);
    const onAbort = () => controller.abort();
    if (signal !== void 0) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    return {
      controller,
      timer,
      detach: () => signal?.removeEventListener("abort", onAbort)
    };
  }
  async #post(url, request, signal) {
    try {
      return await this.#fetch(url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal,
        redirect: "manual"
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (signal.aborted) throw new ProviderError("timeout", "request aborted by timeout or cancellation");
      throw new ProviderError("network_error", error instanceof Error ? error.message : "network failure");
    }
  }
};
async function readBodyCapped(res, max_bytes) {
  const declared = res.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > max_bytes) {
      await res.body?.cancel();
      throw new ProviderError("oversized_response", `response declares ${length} bytes over the ${max_bytes} byte limit`);
    }
  }
  if (res.body === null) {
    const text2 = await res.text();
    if (Buffer.byteLength(text2, "utf8") > max_bytes) {
      throw new ProviderError("oversized_response", `response exceeds the ${max_bytes} byte limit`);
    }
    return text2;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === void 0) continue;
    total += value.byteLength;
    if (total > max_bytes) {
      await reader.cancel();
      throw new ProviderError("oversized_response", `response exceeds the ${max_bytes} byte limit`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
var ToolLoopBudget = class {
  #options;
  #clock;
  #started;
  #turns = 0;
  #total_bytes = 0;
  constructor(options, clock = Date.now) {
    this.#options = { ...options };
    this.#clock = clock;
    this.#started = clock();
  }
  get turns() {
    return this.#turns;
  }
  /**
   * Budgets are enforced per turn boundary. A single in-flight request is
   * bounded by the per-request timeout and the response byte caps, so total
   * wall time can exceed max_run_ms by at most one request timeout plus tool
   * execution; the next beginTurn() then refuses to continue.
   */
  beginTurn() {
    if (this.#turns >= this.#options.max_tool_turns) {
      throw new ProviderError("tool_turn_budget_exceeded", `tool loop exceeded ${this.#options.max_tool_turns} turns`);
    }
    if (this.#clock() - this.#started > this.#options.max_run_ms) {
      throw new ProviderError("tool_time_budget_exceeded", `tool loop exceeded ${this.#options.max_run_ms} ms`);
    }
    this.#turns += 1;
  }
  chargeBytes(count) {
    this.#total_bytes += count;
    if (this.#total_bytes > this.#options.max_total_bytes) {
      throw new ProviderError("tool_byte_budget_exceeded", `tool loop exceeded ${this.#options.max_total_bytes} response bytes`);
    }
  }
};
var DEFAULT_TOOL_BUDGETS = {
  max_tool_turns: 8,
  max_total_bytes: 1048576,
  max_run_ms: 12e4,
  max_output_tokens: 2048,
  max_image_bytes: 20971520,
  max_pixels: 4e6,
  max_crops: 4
};
var SECRET_REF = /^env:[A-Za-z_][A-Za-z0-9_]*$/;
function validateSecretRef(ref) {
  if (typeof ref !== "string" || !SECRET_REF.test(ref)) {
    throw new ProviderError("secret_ref_invalid", "credentials must be given as an env:NAME secret reference, never inline");
  }
}
function resolveSecretRef(ref, env = process.env) {
  validateSecretRef(ref);
  const value = env[ref.slice("env:".length)];
  if (typeof value !== "string" || value.length === 0) {
    throw new ProviderError("secret_ref_invalid", `secret reference ${ref} did not resolve to a value`);
  }
  return value;
}

// apps/agent-host/src/providers/http/images.ts
import { createHash } from "node:crypto";
var MAX_GRANT_ID_LENGTH = 128;
function imageGrantIds(ctx) {
  if (!("approved_grant_ids" in ctx)) {
    throw new ProviderError("image_grant_missing", "the host must provide run-scoped approved image grants");
  }
  const grants = ctx.approved_grant_ids;
  if (!Array.isArray(grants) || grants.length === 0) {
    throw new ProviderError("image_grant_missing", "the run has no approved image grant");
  }
  for (const grant of grants) {
    if (typeof grant !== "string" || grant.length === 0 || grant.length > MAX_GRANT_ID_LENGTH) {
      throw new ProviderError("image_grant_missing", "approved image grant ids must be non-empty strings");
    }
  }
  if (grants.length > 1) {
    throw new ProviderError(
      "image_grant_missing",
      "exactly one approved image grant per run is supported; multiple grants must be split into separate runs"
    );
  }
  return grants;
}
function planImageInputs(input, document, max_crops, scope) {
  if (scope?.allow_image === false) return [];
  if (scope?.approved_image_region) return [{ kind: "crop", region: scope.approved_image_region, object_id: null }];
  const requests = [{ kind: "full", region: null, object_id: null }];
  let crops = 0;
  for (const object_id of input.context.selected_object_ids) {
    if (crops >= max_crops) break;
    const object = document.objects.find((candidate) => candidate.object_id === object_id);
    if (object === void 0) continue;
    requests.push({ kind: "crop", region: object.geometry, object_id });
    crops += 1;
  }
  return requests;
}
var PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
function pngDimensions(bytes) {
  if (bytes.length < 24) throw new ProviderError("image_invalid", "image region is not a PNG payload");
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) throw new ProviderError("image_invalid", "image region is not a PNG payload");
  }
  if (bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) {
    throw new ProviderError("image_invalid", "PNG payload lacks an IHDR chunk");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) throw new ProviderError("image_invalid", "PNG dimensions must be positive");
  return { width, height };
}
function privacyFingerprint(input) {
  const bytes_sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const material = JSON.stringify({
    kind: input.kind,
    region: input.region,
    transform_to_canonical: input.transform_to_canonical,
    bytes_sha256
  });
  return createHash("sha256").update(material).digest("hex");
}
function prepareImage(raw, request, budget) {
  if (raw.mime !== "image/png") throw new ProviderError("image_invalid", "only image/png regions can leave the process");
  if (!(raw.bytes instanceof Uint8Array) || raw.bytes.length === 0) {
    throw new ProviderError("image_invalid", "image region has no bytes");
  }
  if (raw.bytes.length > budget.max_bytes) {
    throw new ProviderError("image_budget_exceeded", `image of ${raw.bytes.length} bytes exceeds the ${budget.max_bytes} byte budget`);
  }
  const transform = raw.transform_to_canonical;
  if (!Array.isArray(transform) || transform.length !== 9 || !transform.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new ProviderError("image_invalid", "transform_to_canonical must be 9 finite numbers");
  }
  const { width, height } = pngDimensions(raw.bytes);
  const pixel_count = width * height;
  if (budget.pixels_used + pixel_count > budget.max_pixels) {
    throw new ProviderError("image_budget_exceeded", `image pixels exceed the ${budget.max_pixels} pixel budget`);
  }
  return {
    kind: request.kind,
    region: request.region,
    object_id: request.object_id,
    bytes: raw.bytes,
    mime: "image/png",
    width,
    height,
    transform_to_canonical: [...transform],
    pixel_count,
    privacy_fingerprint: privacyFingerprint({
      kind: request.kind,
      region: request.region,
      transform_to_canonical: transform,
      bytes: raw.bytes
    }),
    data_url: `data:image/png;base64,${Buffer.from(raw.bytes).toString("base64")}`
  };
}

// apps/agent-host/src/providers/http/usage.ts
function tokenCount(raw, keys) {
  for (const key of keys) {
    const value = raw[key];
    if (value === void 0 || value === null) continue;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    return null;
  }
  return null;
}
function computeCost(input_tokens, output_tokens, pricing) {
  if (pricing === null) return null;
  const { input_per_million_usd, output_per_million_usd } = pricing;
  if (input_per_million_usd === null || output_per_million_usd === null) return null;
  if (!Number.isFinite(input_per_million_usd) || !Number.isFinite(output_per_million_usd)) return null;
  if (input_per_million_usd < 0 || output_per_million_usd < 0) return null;
  if (input_tokens === null || output_tokens === null) return null;
  return (input_tokens * input_per_million_usd + output_tokens * output_per_million_usd) / 1e6;
}
function normalizeUsage(raw, pricing = null) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { input_tokens: null, output_tokens: null, cost_usd: null };
  }
  const record = raw;
  const input_tokens = tokenCount(record, ["input_tokens", "prompt_tokens"]);
  const output_tokens = tokenCount(record, ["output_tokens", "completion_tokens"]);
  return { input_tokens, output_tokens, cost_usd: computeCost(input_tokens, output_tokens, pricing) };
}
function sumKnown(a, b) {
  return a === null || b === null ? null : a + b;
}
function mergeUsage(a, b, pricing = null) {
  const input_tokens = sumKnown(a.input_tokens, b.input_tokens);
  const output_tokens = sumKnown(a.output_tokens, b.output_tokens);
  const priced = computeCost(input_tokens, output_tokens, pricing);
  const cost_usd = priced !== null ? priced : a.cost_usd !== null && b.cost_usd !== null ? a.cost_usd + b.cost_usd : null;
  return { input_tokens, output_tokens, cost_usd };
}
function costDisplay(usage) {
  return usage.cost_usd === null ? "unknown" : "known";
}
function updateObservedUsage(turns, index, raw, pricing) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const record = raw;
  const nextInput = tokenCount(record, ["input_tokens", "prompt_tokens"]);
  const nextOutput = tokenCount(record, ["output_tokens", "completion_tokens"]);
  if (nextInput === null && nextOutput === null) return false;
  const previous = turns[index];
  const input_tokens = nextInput ?? previous?.input_tokens ?? null;
  const output_tokens = nextOutput ?? previous?.output_tokens ?? null;
  if (previous?.input_tokens === input_tokens && previous?.output_tokens === output_tokens) return false;
  turns[index] = { input_tokens, output_tokens, cost_usd: computeCost(input_tokens, output_tokens, pricing) };
  return true;
}
function totalObservedUsage(turns, pricing) {
  return turns.reduce((total, turn) => total === null ? turn : mergeUsage(total, turn, pricing), null) ?? normalizeUsage(null, pricing);
}

// apps/agent-host/src/providers/openai-api.ts
var SYSTEM_TEXT = "You are a WebLabel annotation assistant. Use the provided tools to inspect regions and propose changes.";
var READ_REGION_DESC = "Read an authorized image region as a PNG crop. region=null reads the full image. The crop is attached to the next message; this call returns transform metadata only.";
var PROPOSE_DESC = "Submit proposed annotation changes and quality issues. Use null for omitted issues, optional create attributes or unchanged partial-edit attributes. The server validates every field strictly before anything is stored.";
var REPORT_DESC = "Report suspected quality issues without proposing annotation changes.";
var DEFINITIONS = suggestion_set_schema_default.definitions;
function strictSchema(schema) {
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.split("/").at(-1);
    if (name === "AttributeMap") throw new ProviderError("adapter_error", "attribute schema requires ontology");
    return strictSchema(DEFINITIONS[name]);
  }
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "format" || key === "propertyNames") continue;
    if (key === "oneOf" || key === "anyOf") result.anyOf = value.map(strictSchema);
    else if (key === "items") result.items = strictSchema(value);
    else if (key === "properties") result.properties = Object.fromEntries(
      Object.entries(value).map(([name, child]) => [name, strictSchema(child)])
    );
    else result[key] = value;
  }
  if (result.type === "object") {
    result.additionalProperties = false;
    result.required = Object.keys(result.properties);
  }
  return result;
}
function attributeSchema(defs, partial) {
  const properties = Object.fromEntries(defs.map((def) => {
    const scalar = def.kind === "enum" ? { type: "string", enum: def.enum_values } : { type: def.kind === "text" ? "string" : def.kind };
    return [def.key, partial || !def.required ? { anyOf: [scalar, { type: "null" }] } : scalar];
  }));
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
function toolsForDomain(domain) {
  const attributes = (partial) => domain.ontology.labels.length === 0 ? attributeSchema([], partial) : { anyOf: domain.ontology.labels.map((label) => attributeSchema(label.attributes, partial)) };
  const object = DEFINITIONS.AnnotationObject;
  const annotation = strictSchema({ ...object, properties: {
    ...object.properties,
    attributes: attributes(false)
  } });
  const changes = DEFINITIONS.Change.oneOf.map((change) => {
    const properties = change.properties;
    return strictSchema({ ...change, properties: {
      ...properties,
      ..."object" in properties ? { object: annotation } : {},
      ..."values" in properties ? { values: attributes(true) } : {}
    } });
  });
  const bbox = strictSchema(DEFINITIONS.BBox);
  const issues = { type: "array", items: strictSchema(DEFINITIONS.QualityIssue) };
  return [
    { type: "function", name: "read_region", description: READ_REGION_DESC, strict: true, parameters: {
      type: "object",
      properties: { region: { anyOf: [bbox, { type: "null" }] } },
      required: ["region"],
      additionalProperties: false
    } },
    { type: "function", name: "propose_changes", description: PROPOSE_DESC, strict: true, parameters: {
      type: "object",
      properties: {
        changes: { type: "array", items: { anyOf: changes } },
        issues: { anyOf: [issues, { type: "null" }] },
        score: { type: ["number", "null"] }
      },
      required: ["changes", "issues", "score"],
      additionalProperties: false
    } },
    { type: "function", name: "report_issues", description: REPORT_DESC, strict: true, parameters: {
      type: "object",
      properties: { issues },
      required: ["issues"],
      additionalProperties: false
    } }
  ];
}
function domainToolArguments(name, raw, domain) {
  if (name !== "propose_changes") return raw;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!value || typeof value !== "object" || !("changes" in value) || !Array.isArray(value.changes)) return value;
  if ("issues" in value && value.issues === null) value.issues = [];
  for (const change of value.changes) {
    if (!change || typeof change !== "object") continue;
    const created = change.kind === "create" && change.object && typeof change.object === "object";
    const labelId = created ? change.object.label_id : domain.document.objects.find((object) => object.object_id === change.object_id)?.label_id;
    const defs = domain.ontology.labels.find((label) => label.label_id === labelId)?.attributes ?? [];
    const values = created ? change.object.attributes : change.kind === "set_attributes" ? change.values : null;
    if (!values || typeof values !== "object" || Array.isArray(values)) continue;
    for (const def of defs) if ((!created || !def.required) && values[def.key] === null) delete values[def.key];
  }
  return value;
}
function byteLength(text) {
  return Buffer.byteLength(text, "utf8");
}
async function* consumeResponsesStream(frames, budget, checkpoint, observeResponse) {
  const calls = /* @__PURE__ */ new Map();
  const order = [];
  let text = "";
  let terminal = false;
  let failure = null;
  const first = frames.next();
  void first.catch(() => {
  });
  try {
    yield checkpoint();
    for (let next = await first; !next.done; next = await frames.next()) {
      const frame = next.value;
      budget.chargeBytes(byteLength(frame.data));
      const payload = decodeJson(frame.data);
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new ProviderError("invalid_json", "stream frame is not a JSON object");
      }
      const event = payload;
      const type = typeof event.type === "string" ? event.type : frame.event;
      if ((type === "response.created" || type === "response.in_progress" || type === "response.completed" || type === "response.failed" || type === "response.incomplete") && typeof event.response === "object" && event.response !== null && !Array.isArray(event.response)) {
        const observation = observeResponse(event.response);
        if (observation !== null) yield observation;
      }
      if (type === "response.output_item.added" && typeof event.item === "object" && event.item !== null) {
        const item = event.item;
        if (item.type === "function_call") {
          const item_id = typeof item.id === "string" ? item.id : String(item.call_id ?? "");
          const call = {
            item_id,
            call_id: typeof item.call_id === "string" ? item.call_id : item_id,
            name: typeof item.name === "string" ? item.name : "",
            arguments: typeof item.arguments === "string" ? item.arguments : ""
          };
          calls.set(item_id, call);
          order.push(call);
        }
      } else if (type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
        const call = calls.get(String(event.item_id ?? ""));
        if (call !== void 0) call.arguments += event.delta;
      } else if (type === "response.function_call_arguments.done" && typeof event.arguments === "string") {
        const call = calls.get(String(event.item_id ?? ""));
        if (call !== void 0) call.arguments = event.arguments;
      } else if (type === "response.output_text.delta" && typeof event.delta === "string") {
        text += event.delta;
      } else if (type === "response.completed") {
        terminal = true;
      } else if (type === "response.failed" || type === "response.incomplete") {
        failure = type;
      }
    }
  } finally {
    await frames.return(void 0);
  }
  if (failure !== null) throw new ProviderError("provider_reported_failure", `provider reported ${failure}`);
  if (!terminal) throw new ProviderError("interrupted_stream", "stream ended before response.completed");
  return { toolCalls: order, text };
}
function createOpenAiApiAdapter(config2) {
  if (typeof config2.profile_id !== "string" || config2.profile_id.length === 0) {
    throw new ProviderError("adapter_error", "profile_id must be a non-empty string");
  }
  if (typeof config2.model_id !== "string" || config2.model_id.length === 0) {
    throw new ProviderError("adapter_error", "model_id must be the exact account-available model ID");
  }
  const budgets = { ...DEFAULT_TOOL_BUDGETS, ...config2.budgets };
  const pricing = config2.pricing ?? null;
  const capabilities = config2.capabilities ?? {
    image_input: false,
    tools: false,
    structured_output: false,
    bbox_output: false,
    attributes: false
  };
  const client = new BoundedHttpClient({
    provider_id: "openai_api",
    api_base: config2.api_base,
    base_approval: config2.base_approval,
    local_admins: config2.local_admins,
    fetch_impl: config2.fetch_impl,
    timeout_ms: config2.timeout_ms,
    max_response_bytes: config2.max_response_bytes,
    max_stream_bytes: config2.max_stream_bytes
  });
  function buildRequestBody(items, tools) {
    return {
      model: config2.model_id,
      stream: true,
      max_output_tokens: budgets.max_output_tokens,
      instructions: SYSTEM_TEXT,
      input: items,
      tools,
      tool_choice: "auto"
    };
  }
  function imageProgress(image) {
    return {
      kind: image.kind,
      object_id: image.object_id,
      transform_to_canonical: image.transform_to_canonical,
      privacy_fingerprint: image.privacy_fingerprint,
      pixel_count: image.pixel_count
    };
  }
  return {
    async probe() {
      let availability;
      if (config2.account_model_verified !== true) {
        availability = "blocked";
      } else {
        let configured = client.base_error === null;
        if (configured) {
          try {
            validateSecretRef(config2.credential?.secret_ref ?? "");
          } catch {
            configured = false;
          }
        }
        availability = configured ? "ready" : "needs_configuration";
      }
      return [
        {
          profile_id: config2.profile_id,
          provider_id: "openai_api",
          model_id: config2.model_id,
          auth_kind: "api_key",
          capabilities,
          availability,
          verification: "not_run",
          runtime_version: null,
          verified_at: null
        }
      ];
    },
    async *run(input, ctx, signal) {
      const run_id = ctx.run_id;
      let seq = 0;
      let knownSecrets = [];
      const emit = (type, message, data) => ({
        run_id,
        seq: seq++,
        type,
        message: redactText(message, knownSecrets),
        data: data === null ? null : redactValue(data, void 0, knownSecrets)
      });
      yield emit("started", "run started", null);
      const turnUsages = [];
      const receipts = [];
      const checkpoint = () => {
        const usage = totalObservedUsage(turnUsages, pricing);
        const event = emit("progress", "provider observation checkpoint", {
          receipts,
          receipt: receipts.at(-1) ?? null,
          usage,
          cost_display: costDisplay(usage)
        });
        if (Buffer.byteLength(JSON.stringify(event.data), "utf8") > 16 * 1024) {
          event.data = { dropped: "event_data_too_large" };
        }
        return event;
      };
      try {
        const secret = resolveSecretRef(config2.credential.secret_ref, config2.secret_env ?? process.env);
        knownSecrets = [secret];
        const budget = new ToolLoopBudget(budgets);
        const document = await ctx.get_document();
        const ontology = await ctx.get_ontology();
        const domain = { intent: input.intent, bbox_output: capabilities.bbox_output, document, ontology };
        const tools = toolsForDomain(domain);
        const grantIds = "allow_image" in ctx && ctx.allow_image === false ? [] : imageGrantIds(ctx);
        const imageBudget = { max_bytes: budgets.max_image_bytes, max_pixels: budgets.max_pixels, pixels_used: 0 };
        const items = [];
        const firstContent = [{ type: "input_text", text: input.prompt }];
        for (const request of planImageInputs(input, document, budgets.max_crops, ctx)) {
          const image = prepareImage(await ctx.read_region(grantIds[0], request.region), request, imageBudget);
          imageBudget.pixels_used += image.pixel_count;
          firstContent.push({ type: "input_image", image_url: image.data_url, detail: "auto" });
          yield emit("progress", `image input ${image.kind}`, imageProgress(image));
        }
        items.push({ role: "user", content: firstContent });
        for (; ; ) {
          budget.beginTurn();
          client.resolveRequestUrl("/responses");
          const receipt = {
            provider_id: "openai_api",
            requested_model_id: config2.model_id,
            actual_model_id: null,
            response_id: null,
            auth_kind: "api_key",
            transport: "openai_responses_sse",
            runtime_version: null,
            runtime_version_status: "not_exposed",
            budgets: {
              max_tool_turns: budgets.max_tool_turns,
              max_run_ms: budgets.max_run_ms,
              max_total_bytes: budgets.max_total_bytes,
              request_timeout_ms: config2.timeout_ms ?? 6e4,
              cost_usd: null
            }
          };
          receipts.push(receipt);
          const usageIndex = turnUsages.length;
          const frames = client.sendStream(
            "/responses",
            {
              headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
              body: JSON.stringify(buildRequestBody(items, tools))
            },
            signal
          );
          const parsed = yield* consumeResponsesStream(frames, budget, checkpoint, (response) => {
            let changed = false;
            if (typeof response.id === "string" && response.id.length > 0 && response.id !== receipt.response_id) {
              receipt.response_id = response.id;
              changed = true;
            }
            if (typeof response.model === "string" && response.model.length > 0 && response.model !== receipt.actual_model_id) {
              receipt.actual_model_id = response.model;
              changed = true;
            }
            changed = updateObservedUsage(turnUsages, usageIndex, response.usage, pricing) || changed;
            return changed ? checkpoint() : null;
          });
          turnUsages[usageIndex] ??= normalizeUsage(null, pricing);
          let proposed = false;
          for (const call of parsed.toolCalls) {
            items.push({ type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments });
            yield emit("tool_call", `tool ${call.name}`, { name: call.name, call_id: call.call_id });
            const args = parseToolCallArguments(call.name, domainToolArguments(call.name, call.arguments, domain), domain);
            if (args.tool === "read_region") {
              const image = prepareImage(
                await ctx.read_region(grantIds[0], args.region),
                { kind: args.region === null ? "full" : "crop", region: args.region, object_id: null },
                imageBudget
              );
              imageBudget.pixels_used += image.pixel_count;
              items.push({
                type: "function_call_output",
                call_id: call.call_id,
                output: JSON.stringify({
                  kind: image.kind,
                  region: image.region,
                  width: image.width,
                  height: image.height,
                  transform_to_canonical: image.transform_to_canonical,
                  mime: image.mime
                })
              });
              items.push({ role: "user", content: [{ type: "input_image", image_url: image.data_url, detail: "auto" }] });
              yield emit("progress", "tool read_region result", imageProgress(image));
            } else if (args.tool === "propose_changes") {
              await ctx.submit_candidates(args.draft);
              proposed = true;
              items.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ accepted: true }) });
              yield emit("candidate", "candidate submitted", {
                change_ids: args.draft.changes.map((change) => change.change_id),
                issue_ids: args.draft.issues.map((issue) => issue.issue_id),
                score: args.draft.score
              });
            } else {
              await ctx.report_issues(args.issues);
              items.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ accepted: true }) });
              yield emit("progress", "quality issues reported", { issue_ids: args.issues.map((issue) => issue.issue_id) });
            }
          }
          if (parsed.toolCalls.length === 0) {
            let candidate;
            try {
              candidate = decodeJson(parsed.text);
            } catch {
              throw new ProviderError("candidate_invalid", "model output is not parseable candidate JSON");
            }
            const draft = validateCandidateDraft(candidate, domain);
            await ctx.submit_candidates(draft);
            proposed = true;
            yield emit("candidate", "candidate submitted", {
              change_ids: draft.changes.map((change) => change.change_id),
              issue_ids: draft.issues.map((issue) => issue.issue_id),
              score: draft.score
            });
          }
          if (proposed) break;
        }
        const usage = totalObservedUsage(turnUsages, pricing);
        yield emit("succeeded", "run succeeded", {
          usage,
          cost_display: costDisplay(usage),
          turns: budget.turns,
          receipts,
          receipt: receipts.at(-1) ?? null
        });
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : "adapter_error";
        const message = error instanceof Error ? error.message : "unexpected adapter failure";
        const usage = totalObservedUsage(turnUsages, pricing);
        if (signal?.aborted === true) {
          yield emit("cancelled", "run cancelled", {
            usage,
            cost_display: costDisplay(usage),
            receipts,
            receipt: receipts.at(-1) ?? null
          });
          return;
        }
        yield emit("failed", `run failed: ${code}`, {
          error_code: code,
          error_message: message,
          usage,
          cost_display: costDisplay(usage),
          receipts,
          receipt: receipts.at(-1) ?? null
        });
      }
    }
  };
}

// apps/agent-host/src/providers/anthropic-api.ts
var SYSTEM_TEXT2 = "You are a WebLabel annotation assistant. Use the provided tools to inspect regions and propose changes.";
var READ_REGION_DESC2 = "Read an authorized image region as a PNG crop. region=null reads the full image. The crop is attached to the next message; this call returns transform metadata only.";
var PROPOSE_DESC2 = "Submit proposed annotation changes and quality issues. The server validates every field strictly before anything is stored.";
var REPORT_DESC2 = "Report suspected quality issues without proposing annotation changes.";
var READ_REGION_SCHEMA = {
  type: "object",
  properties: {
    region: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            type: { const: "bbox_xyxy" },
            x_min: { type: "number" },
            y_min: { type: "number" },
            x_max: { type: "number" },
            y_max: { type: "number" }
          },
          required: ["type", "x_min", "y_min", "x_max", "y_max"],
          additionalProperties: false
        }
      ]
    }
  },
  required: ["region"],
  additionalProperties: false
};
var PROPOSE_SCHEMA = {
  type: "object",
  properties: {
    changes: {
      type: "array",
      items: {
        type: "object",
        required: ["kind", "change_id", "reason"],
        properties: { kind: { type: "string" } }
      }
    },
    issues: { type: "array", items: { type: "object" } },
    score: { type: ["number", "null"] }
  },
  required: ["changes"],
  additionalProperties: false
};
var REPORT_SCHEMA = {
  type: "object",
  properties: { issues: { type: "array", items: { type: "object" } } },
  required: ["issues"],
  additionalProperties: false
};
var TOOLS = [
  { name: "read_region", description: READ_REGION_DESC2, input_schema: READ_REGION_SCHEMA },
  { name: "propose_changes", description: PROPOSE_DESC2, input_schema: PROPOSE_SCHEMA },
  { name: "report_issues", description: REPORT_DESC2, input_schema: REPORT_SCHEMA }
];
function byteLength2(text) {
  return Buffer.byteLength(text, "utf8");
}
function usageField(container, key) {
  if (typeof container !== "object" || container === null) return void 0;
  const usage = container.usage;
  if (typeof usage !== "object" || usage === null) return void 0;
  const value = usage[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : void 0;
}
async function consumeAnthropicStream(frames, budget) {
  const calls = /* @__PURE__ */ new Map();
  const order = [];
  let text = "";
  let input_tokens;
  let output_tokens;
  let terminal = false;
  let failure = null;
  for await (const frame of frames) {
    budget.chargeBytes(byteLength2(frame.data));
    const payload = decodeJson(frame.data);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new ProviderError("invalid_json", "stream frame is not a JSON object");
    }
    const event = payload;
    const type = typeof event.type === "string" ? event.type : frame.event;
    if (type === "message_start") {
      input_tokens = usageField(event.message, "input_tokens") ?? input_tokens;
    } else if (type === "content_block_start" && typeof event.index === "number" && typeof event.content_block === "object" && event.content_block !== null) {
      const block = event.content_block;
      if (block.type === "tool_use") {
        const call = {
          id: typeof block.id === "string" ? block.id : "",
          name: typeof block.name === "string" ? block.name : "",
          arguments: ""
        };
        calls.set(event.index, call);
        order.push(call);
      }
    } else if (type === "content_block_delta" && typeof event.index === "number" && typeof event.delta === "object" && event.delta !== null) {
      const delta = event.delta;
      const call = calls.get(event.index);
      if (call !== void 0 && delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        call.arguments += delta.partial_json;
      } else if (delta.type === "text_delta" && typeof delta.text === "string") {
        text += delta.text;
      }
    } else if (type === "message_delta") {
      output_tokens = usageField(event, "output_tokens") ?? output_tokens;
      input_tokens = usageField(event, "input_tokens") ?? input_tokens;
    } else if (type === "message_stop") {
      terminal = true;
    } else if (type === "error") {
      const error = event.error;
      failure = error !== null && typeof error === "object" && typeof error.message === "string" ? error.message : "provider error frame";
    }
  }
  if (failure !== null) throw new ProviderError("provider_reported_failure", failure);
  if (!terminal) throw new ProviderError("interrupted_stream", "stream ended before message_stop");
  return { toolCalls: order, text, usage: { input_tokens: input_tokens ?? null, output_tokens: output_tokens ?? null } };
}
function createAnthropicApiAdapter(config2) {
  if (typeof config2.profile_id !== "string" || config2.profile_id.length === 0) {
    throw new ProviderError("adapter_error", "profile_id must be a non-empty string");
  }
  if (typeof config2.model_id !== "string" || config2.model_id.length === 0) {
    throw new ProviderError("adapter_error", "model_id must be the exact account-available model ID");
  }
  const budgets = { ...DEFAULT_TOOL_BUDGETS, ...config2.budgets };
  const pricing = config2.pricing ?? null;
  const capabilities = config2.capabilities ?? {
    image_input: false,
    tools: false,
    structured_output: false,
    bbox_output: false,
    attributes: false
  };
  const client = new BoundedHttpClient({
    provider_id: "anthropic_api",
    api_base: config2.api_base,
    base_approval: config2.base_approval,
    local_admins: config2.local_admins,
    fetch_impl: config2.fetch_impl,
    timeout_ms: config2.timeout_ms,
    max_response_bytes: config2.max_response_bytes,
    max_stream_bytes: config2.max_stream_bytes
  });
  function buildRequestBody(messages) {
    return {
      model: config2.model_id,
      max_tokens: budgets.max_output_tokens,
      system: SYSTEM_TEXT2,
      messages,
      tools: TOOLS,
      stream: true
    };
  }
  function imageBlock(image) {
    return {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: Buffer.from(image.bytes).toString("base64") }
    };
  }
  function imageProgress(image) {
    return {
      kind: image.kind,
      object_id: image.object_id,
      transform_to_canonical: image.transform_to_canonical,
      privacy_fingerprint: image.privacy_fingerprint,
      pixel_count: image.pixel_count
    };
  }
  return {
    async probe() {
      let availability;
      if (config2.account_model_verified !== true) {
        availability = "blocked";
      } else {
        let configured = client.base_error === null;
        if (configured) {
          try {
            validateSecretRef(config2.credential?.secret_ref ?? "");
          } catch {
            configured = false;
          }
        }
        availability = configured ? "ready" : "needs_configuration";
      }
      return [
        {
          profile_id: config2.profile_id,
          provider_id: "anthropic_api",
          model_id: config2.model_id,
          auth_kind: "api_key",
          capabilities,
          availability,
          verification: "not_run",
          runtime_version: null,
          verified_at: null
        }
      ];
    },
    async *run(input, ctx, signal) {
      const run_id = ctx.run_id;
      let seq = 0;
      let knownSecrets = [];
      const emit = (type, message, data) => ({
        run_id,
        seq: seq++,
        type,
        message: redactText(message, knownSecrets),
        data: data === null ? null : redactValue(data, void 0, knownSecrets)
      });
      yield emit("started", "run started", null);
      const turnUsages = [];
      try {
        const secret = resolveSecretRef(config2.credential.secret_ref, config2.secret_env ?? process.env);
        knownSecrets = [secret];
        const budget = new ToolLoopBudget(budgets);
        const document = await ctx.get_document();
        const ontology = await ctx.get_ontology();
        const domain = { intent: input.intent, bbox_output: capabilities.bbox_output, document, ontology };
        const grantIds = "allow_image" in ctx && ctx.allow_image === false ? [] : imageGrantIds(ctx);
        const imageBudget = { max_bytes: budgets.max_image_bytes, max_pixels: budgets.max_pixels, pixels_used: 0 };
        const messages = [];
        const firstContent = [{ type: "text", text: input.prompt }];
        for (const request of planImageInputs(input, document, budgets.max_crops, ctx)) {
          const image = prepareImage(await ctx.read_region(grantIds[0], request.region), request, imageBudget);
          imageBudget.pixels_used += image.pixel_count;
          firstContent.push(imageBlock(image));
          yield emit("progress", `image input ${image.kind}`, imageProgress(image));
        }
        messages.push({ role: "user", content: firstContent });
        for (; ; ) {
          budget.beginTurn();
          const frames = client.sendStream(
            "/v1/messages",
            {
              headers: {
                "x-api-key": secret,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json"
              },
              body: JSON.stringify(buildRequestBody(messages))
            },
            signal
          );
          const parsed = await consumeAnthropicStream(frames, budget);
          turnUsages.push(normalizeUsage(parsed.usage, pricing));
          let proposed = false;
          for (const call of parsed.toolCalls) {
            const args = parseToolCallArguments(call.name, call.arguments, domain);
            const toolInput = args.tool === "read_region" ? { region: args.region } : args.tool === "report_issues" ? { issues: args.issues } : { changes: args.draft.changes, issues: args.draft.issues, score: args.draft.score };
            messages.push({
              role: "assistant",
              content: [{ type: "tool_use", id: call.id, name: call.name, input: toolInput }]
            });
            yield emit("tool_call", `tool ${call.name}`, { name: call.name, call_id: call.id });
            if (args.tool === "read_region") {
              const image = prepareImage(
                await ctx.read_region(grantIds[0], args.region),
                { kind: args.region === null ? "full" : "crop", region: args.region, object_id: null },
                imageBudget
              );
              imageBudget.pixels_used += image.pixel_count;
              messages.push({
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: call.id,
                    content: JSON.stringify({
                      kind: image.kind,
                      region: image.region,
                      width: image.width,
                      height: image.height,
                      transform_to_canonical: image.transform_to_canonical,
                      mime: image.mime
                    })
                  },
                  imageBlock(image)
                ]
              });
              yield emit("progress", "tool read_region result", imageProgress(image));
            } else if (args.tool === "propose_changes") {
              await ctx.submit_candidates(args.draft);
              proposed = true;
              messages.push({
                role: "user",
                content: [{ type: "tool_result", tool_use_id: call.id, content: JSON.stringify({ accepted: true }) }]
              });
              yield emit("candidate", "candidate submitted", {
                change_ids: args.draft.changes.map((change) => change.change_id),
                issue_ids: args.draft.issues.map((issue) => issue.issue_id),
                score: args.draft.score
              });
            } else {
              await ctx.report_issues(args.issues);
              messages.push({
                role: "user",
                content: [{ type: "tool_result", tool_use_id: call.id, content: JSON.stringify({ accepted: true }) }]
              });
              yield emit("progress", "quality issues reported", { issue_ids: args.issues.map((issue) => issue.issue_id) });
            }
          }
          if (parsed.toolCalls.length === 0) {
            let candidate;
            try {
              candidate = decodeJson(parsed.text);
            } catch {
              throw new ProviderError("candidate_invalid", "model output is not parseable candidate JSON");
            }
            const draft = validateCandidateDraft(candidate, domain);
            await ctx.submit_candidates(draft);
            proposed = true;
            yield emit("candidate", "candidate submitted", {
              change_ids: draft.changes.map((change) => change.change_id),
              issue_ids: draft.issues.map((issue) => issue.issue_id),
              score: draft.score
            });
          }
          if (proposed) break;
        }
        const usage = turnUsages.reduce((acc, turn) => acc === null ? turn : mergeUsage(acc, turn, pricing), null) ?? normalizeUsage(null, pricing);
        yield emit("succeeded", "run succeeded", { usage, cost_display: costDisplay(usage), turns: budget.turns });
      } catch (error) {
        if (signal?.aborted === true) {
          yield emit("cancelled", "run cancelled", null);
          return;
        }
        const code = error instanceof ProviderError ? error.code : "adapter_error";
        const message = error instanceof Error ? error.message : "unexpected adapter failure";
        const usage = turnUsages.reduce((acc, turn) => acc === null ? turn : mergeUsage(acc, turn, pricing), null) ?? normalizeUsage(null, pricing);
        yield emit("failed", `run failed: ${code}`, {
          error_code: code,
          error_message: message,
          usage,
          cost_display: costDisplay(usage)
        });
      }
    }
  };
}

// apps/agent-host/src/providers/mimo-api.ts
var SYSTEM_TEXT3 = "You are a WebLabel annotation assistant. Use the provided tools to inspect regions and propose changes.";
var READ_REGION_DESC3 = "Read an authorized image region as a PNG crop. region=null reads the full image. The crop is attached to the next message; this call returns transform metadata only.";
var PROPOSE_DESC3 = "Submit proposed annotation changes and quality issues. The server validates every field strictly before anything is stored.";
var REPORT_DESC3 = "Report suspected quality issues without proposing annotation changes.";
var READ_REGION_SCHEMA2 = {
  type: "object",
  properties: {
    region: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            type: { const: "bbox_xyxy" },
            x_min: { type: "number" },
            y_min: { type: "number" },
            x_max: { type: "number" },
            y_max: { type: "number" }
          },
          required: ["type", "x_min", "y_min", "x_max", "y_max"],
          additionalProperties: false
        }
      ]
    }
  },
  required: ["region"],
  additionalProperties: false
};
var PROPOSE_SCHEMA2 = {
  type: "object",
  properties: {
    changes: {
      type: "array",
      items: {
        type: "object",
        required: ["kind", "change_id", "reason"],
        properties: { kind: { type: "string" } }
      }
    },
    issues: { type: "array", items: { type: "object" } },
    score: { type: ["number", "null"] }
  },
  required: ["changes"],
  additionalProperties: false
};
var REPORT_SCHEMA2 = {
  type: "object",
  properties: { issues: { type: "array", items: { type: "object" } } },
  required: ["issues"],
  additionalProperties: false
};
var TOOLS2 = [
  { type: "function", function: { name: "read_region", description: READ_REGION_DESC3, parameters: READ_REGION_SCHEMA2 } },
  { type: "function", function: { name: "propose_changes", description: PROPOSE_DESC3, parameters: PROPOSE_SCHEMA2 } },
  { type: "function", function: { name: "report_issues", description: REPORT_DESC3, parameters: REPORT_SCHEMA2 } }
];
function byteLength3(text) {
  return Buffer.byteLength(text, "utf8");
}
async function* consumeMiMoStream(frames, budget, checkpoint, observeChunk) {
  const calls = /* @__PURE__ */ new Map();
  const order = [];
  let text = "";
  let terminal = false;
  const first = frames.next();
  void first.catch(() => {
  });
  try {
    yield checkpoint();
    for (let next = await first; !next.done; next = await frames.next()) {
      const frame = next.value;
      budget.chargeBytes(byteLength3(frame.data));
      if (frame.data === "[DONE]") {
        terminal = true;
        continue;
      }
      const payload = decodeJson(frame.data);
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new ProviderError("invalid_json", "stream frame is not a JSON object");
      }
      const chunk = payload;
      const observation = observeChunk(chunk);
      if (observation !== null) yield observation;
      if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) continue;
      const choice = chunk.choices[0];
      if (typeof choice !== "object" || choice === null) continue;
      const { delta, finish_reason } = choice;
      if (typeof delta === "object" && delta !== null) {
        const { content, tool_calls } = delta;
        if (typeof content === "string") text += content;
        if (Array.isArray(tool_calls)) {
          for (const entry of tool_calls) {
            if (typeof entry !== "object" || entry === null) continue;
            const { index, id, function: fn } = entry;
            if (typeof index !== "number") continue;
            let call = calls.get(index);
            if (call === void 0) {
              call = { id: typeof id === "string" ? id : `call_${index}`, name: "", arguments: "" };
              calls.set(index, call);
              order.push(call);
            }
            if (typeof id === "string") call.id = id;
            if (typeof fn === "object" && fn !== null) {
              const { name, arguments: args } = fn;
              if (typeof name === "string") call.name = name;
              if (typeof args === "string") call.arguments += args;
            }
          }
        }
      }
      if (typeof finish_reason === "string" && finish_reason !== "tool_calls" && finish_reason !== "stop") {
        throw new ProviderError("provider_reported_failure", `provider finished with ${finish_reason}`);
      }
    }
  } finally {
    await frames.return(void 0);
  }
  if (!terminal) throw new ProviderError("interrupted_stream", "stream ended before [DONE]");
  return { toolCalls: order, text };
}
function createMiMoApiAdapter(config2) {
  if (typeof config2.profile_id !== "string" || config2.profile_id.length === 0) {
    throw new ProviderError("adapter_error", "profile_id must be a non-empty string");
  }
  if (typeof config2.model_id !== "string" || config2.model_id.length === 0) {
    throw new ProviderError("adapter_error", "model_id must be the exact documented model ID");
  }
  const budgets = { ...DEFAULT_TOOL_BUDGETS, ...config2.budgets };
  const pricing = config2.pricing ?? null;
  const capabilities = config2.capabilities ?? {
    image_input: false,
    tools: false,
    structured_output: false,
    bbox_output: false,
    attributes: false
  };
  const client = new BoundedHttpClient({
    provider_id: "mimo_api",
    api_base: config2.api_base,
    base_approval: config2.base_approval,
    local_admins: config2.local_admins,
    fetch_impl: config2.fetch_impl,
    timeout_ms: config2.timeout_ms,
    max_response_bytes: config2.max_response_bytes,
    max_stream_bytes: config2.max_stream_bytes
  });
  function buildRequestBody(messages) {
    return {
      model: config2.model_id,
      stream: true,
      max_tokens: budgets.max_output_tokens,
      messages,
      tools: TOOLS2,
      tool_choice: "auto"
    };
  }
  function imagePart(image) {
    return { type: "image_url", image_url: { url: image.data_url } };
  }
  function imageProgress(image) {
    return {
      kind: image.kind,
      object_id: image.object_id,
      transform_to_canonical: image.transform_to_canonical,
      privacy_fingerprint: image.privacy_fingerprint,
      pixel_count: image.pixel_count
    };
  }
  return {
    async probe() {
      let availability;
      if (config2.account_model_verified !== true) {
        availability = "blocked";
      } else {
        let configured = client.base_error === null;
        if (configured) {
          try {
            validateSecretRef(config2.credential?.secret_ref ?? "");
          } catch {
            configured = false;
          }
        }
        availability = configured ? "ready" : "needs_configuration";
      }
      return [
        {
          profile_id: config2.profile_id,
          provider_id: "mimo_api",
          model_id: config2.model_id,
          auth_kind: "api_key",
          capabilities,
          availability,
          verification: "not_run",
          runtime_version: null,
          verified_at: null
        }
      ];
    },
    async *run(input, ctx, signal) {
      const run_id = ctx.run_id;
      let seq = 0;
      let knownSecrets = [];
      const emit = (type, message, data) => ({
        run_id,
        seq: seq++,
        type,
        message: redactText(message, knownSecrets),
        data: data === null ? null : redactValue(data, void 0, knownSecrets)
      });
      yield emit("started", "run started", null);
      const turnUsages = [];
      const receipts = [];
      const checkpoint = () => {
        const usage = totalObservedUsage(turnUsages, pricing);
        const event = emit("progress", "provider observation checkpoint", {
          receipts,
          receipt: receipts.at(-1) ?? null,
          usage,
          cost_display: costDisplay(usage)
        });
        if (Buffer.byteLength(JSON.stringify(event.data), "utf8") > 16 * 1024) {
          event.data = { dropped: "event_data_too_large" };
        }
        return event;
      };
      try {
        const secret = resolveSecretRef(config2.credential.secret_ref, config2.secret_env ?? process.env);
        knownSecrets = [secret];
        if (secret.startsWith("tp-") && (config2.api_base === void 0 || config2.api_base === OFFICIAL_API_BASES.mimo_api)) {
          throw new ProviderError("base_not_approved", "Token Plan credentials require the exact console-provided base URL");
        }
        const budget = new ToolLoopBudget(budgets);
        const document = await ctx.get_document();
        const ontology = await ctx.get_ontology();
        const domain = { intent: input.intent, bbox_output: capabilities.bbox_output, document, ontology };
        const grantIds = "allow_image" in ctx && ctx.allow_image === false ? [] : imageGrantIds(ctx);
        const imageBudget = { max_bytes: budgets.max_image_bytes, max_pixels: budgets.max_pixels, pixels_used: 0 };
        const messages = [{ role: "system", content: SYSTEM_TEXT3 }];
        const firstContent = [{ type: "text", text: input.prompt }];
        for (const request of planImageInputs(input, document, budgets.max_crops, ctx)) {
          const image = prepareImage(await ctx.read_region(grantIds[0], request.region), request, imageBudget);
          imageBudget.pixels_used += image.pixel_count;
          firstContent.push(imagePart(image));
          yield emit("progress", `image input ${image.kind}`, imageProgress(image));
        }
        messages.push({ role: "user", content: firstContent });
        for (; ; ) {
          budget.beginTurn();
          client.resolveRequestUrl("/chat/completions");
          const receipt = {
            provider_id: "mimo_api",
            requested_model_id: config2.model_id,
            actual_model_id: null,
            response_id: null,
            auth_kind: "api_key",
            transport: "mimo_chat_completions_sse",
            runtime_version: null,
            runtime_version_status: "not_exposed",
            budgets: {
              max_tool_turns: budgets.max_tool_turns,
              max_run_ms: budgets.max_run_ms,
              max_total_bytes: budgets.max_total_bytes,
              request_timeout_ms: config2.timeout_ms ?? 6e4,
              cost_usd: null
            }
          };
          receipts.push(receipt);
          const usageIndex = turnUsages.length;
          const frames = client.sendStream(
            "/chat/completions",
            {
              headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
              body: JSON.stringify(buildRequestBody(messages))
            },
            signal
          );
          const parsed = yield* consumeMiMoStream(frames, budget, checkpoint, (chunk) => {
            let changed = false;
            if (typeof chunk.id === "string" && chunk.id.length > 0 && chunk.id !== receipt.response_id) {
              receipt.response_id = chunk.id;
              changed = true;
            }
            if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== receipt.actual_model_id) {
              receipt.actual_model_id = chunk.model;
              changed = true;
            }
            changed = updateObservedUsage(turnUsages, usageIndex, chunk.usage, pricing) || changed;
            return changed ? checkpoint() : null;
          });
          turnUsages[usageIndex] ??= normalizeUsage(null, pricing);
          let proposed = false;
          for (const call of parsed.toolCalls) {
            messages.push({
              role: "assistant",
              content: null,
              tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }]
            });
            yield emit("tool_call", `tool ${call.name}`, { name: call.name, call_id: call.id });
            const args = parseToolCallArguments(call.name, call.arguments, domain);
            if (args.tool === "read_region") {
              const image = prepareImage(
                await ctx.read_region(grantIds[0], args.region),
                { kind: args.region === null ? "full" : "crop", region: args.region, object_id: null },
                imageBudget
              );
              imageBudget.pixels_used += image.pixel_count;
              messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: JSON.stringify({
                  kind: image.kind,
                  region: image.region,
                  width: image.width,
                  height: image.height,
                  transform_to_canonical: image.transform_to_canonical,
                  mime: image.mime
                })
              });
              messages.push({ role: "user", content: [imagePart(image)] });
              yield emit("progress", "tool read_region result", imageProgress(image));
            } else if (args.tool === "propose_changes") {
              await ctx.submit_candidates(args.draft);
              proposed = true;
              messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ accepted: true }) });
              yield emit("candidate", "candidate submitted", {
                change_ids: args.draft.changes.map((change) => change.change_id),
                issue_ids: args.draft.issues.map((issue) => issue.issue_id),
                score: args.draft.score
              });
            } else {
              await ctx.report_issues(args.issues);
              messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ accepted: true }) });
              yield emit("progress", "quality issues reported", { issue_ids: args.issues.map((issue) => issue.issue_id) });
            }
          }
          if (parsed.toolCalls.length === 0) {
            let candidate;
            try {
              candidate = decodeJson(parsed.text);
            } catch {
              throw new ProviderError("candidate_invalid", "model output is not parseable candidate JSON");
            }
            const draft = validateCandidateDraft(candidate, domain);
            await ctx.submit_candidates(draft);
            proposed = true;
            yield emit("candidate", "candidate submitted", {
              change_ids: draft.changes.map((change) => change.change_id),
              issue_ids: draft.issues.map((issue) => issue.issue_id),
              score: draft.score
            });
          }
          if (proposed) break;
        }
        const usage = totalObservedUsage(turnUsages, pricing);
        yield emit("succeeded", "run succeeded", {
          usage,
          cost_display: costDisplay(usage),
          turns: budget.turns,
          receipts,
          receipt: receipts.at(-1) ?? null
        });
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : "adapter_error";
        const message = error instanceof Error ? error.message : "unexpected adapter failure";
        const usage = totalObservedUsage(turnUsages, pricing);
        if (signal?.aborted === true) {
          yield emit("cancelled", "run cancelled", {
            usage,
            cost_display: costDisplay(usage),
            receipts,
            receipt: receipts.at(-1) ?? null
          });
          return;
        }
        yield emit("failed", `run failed: ${code}`, {
          error_code: code,
          error_message: message,
          usage,
          cost_display: costDisplay(usage),
          receipts,
          receipt: receipts.at(-1) ?? null
        });
      }
    }
  };
}

// apps/agent-host/src/providers/claude/adapter.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync2 } from "node:fs";
import { dirname, isAbsolute as isAbsolute3, join as join2, resolve as resolve3 } from "node:path";

// apps/agent-host/src/providers/claude/permissions.ts
import { randomUUID } from "node:crypto";
import { existsSync as existsSync2, mkdirSync, realpathSync as realpathSync2, writeFileSync } from "node:fs";
import { isAbsolute as isAbsolute2, join, relative as relative2, resolve as resolve2, sep as sep2 } from "node:path";

// apps/agent-host/src/mcp/tools.ts
var TOOL_NAMES = [
  "get_context",
  "list_objects",
  "propose_changes",
  "read_region",
  "report_issues"
];

// apps/agent-host/src/providers/claude/permissions.ts
var ClaudePermissionError = class extends Error {
  code;
  constructor(code, detail) {
    super(detail === void 0 ? code : `${code}: ${detail}`);
    this.name = "ClaudePermissionError";
    this.code = code;
  }
};
var MCP_SERVER_NAME = "weblabel-agent-tools";
var RUN_TOKEN_ENV = "WEBLABEL_RUN_TOKEN";
var API_BASE_ENV = "WEBLABEL_API_BASE";
var DEFAULT_API_BASE = "http://127.0.0.1:48100";
function mcpToolName(tool) {
  return `mcp__${MCP_SERVER_NAME}__${tool}`;
}
var PERMITTED_TOOLS = [...TOOL_NAMES].map(mcpToolName);
var DENIED_BUILTIN_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "Read",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Glob",
  "Grep",
  "Task"
];
var CANDIDATE_JSON_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["changes"],
  properties: {
    changes: { type: "array", items: { type: "object" } },
    issues: { type: "array", items: { type: "object" } },
    score: { type: ["number", "null"] }
  }
});
var ENV_NAME2 = /^[A-Za-z_][A-Za-z0-9_]*$/;
var RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var MAX_TOOL_NAME_LENGTH = 128;
var DENIED_ENV_NAMES = {
  NODE_OPTIONS: true,
  WEBLABEL_RUN_TOKEN: true,
  // Credential channels: this profile is the user's official subscription
  // login. Letting an API key or OAuth token into the child would silently
  // switch billing and could disguise an API call as a subscription run.
  ANTHROPIC_API_KEY: true,
  ANTHROPIC_AUTH_TOKEN: true,
  CLAUDE_CODE_OAUTH_TOKEN: true
};
function rejected(code, detail) {
  return new ClaudePermissionError(code, detail);
}
function validToolName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TOOL_NAME_LENGTH;
}
function assertCommandSpec(spec, label, runToken) {
  if (typeof spec.executable !== "string" || spec.executable.length === 0 || spec.executable.includes("\0")) {
    throw rejected("executable_invalid", `${label} executable must be a non-empty string without NUL bytes`);
  }
  for (const entry of spec.argv) {
    if (typeof entry !== "string" || entry.includes("\0") || entry.includes("\n") || entry.includes("\r")) {
      throw rejected("argv_invalid", `${label} argv entries must be single-line strings`);
    }
    if (entry.startsWith("-")) {
      throw rejected("argv_flag_injection", `${label} argv must not contain CLI flags: ${entry}`);
    }
    if (runToken.length > 0 && entry.includes(runToken)) {
      throw rejected("token_in_argv", "the run-scoped token travels via child environment only, never argv");
    }
  }
  if (runToken.length > 0 && spec.executable.includes(runToken)) {
    throw rejected("token_in_argv", "the run-scoped token travels via child environment only, never argv");
  }
}
function canonicalDir(target, label) {
  if (typeof target !== "string" || target.length === 0 || !isAbsolute2(target)) {
    throw rejected(`${label}_untrusted`, "must be an absolute path");
  }
  if (!existsSync2(target)) throw rejected(`${label}_missing`, target);
  return realpathSync2(target);
}
function dirContains(root, target) {
  const rel = relative2(root, target);
  return rel === "" || !isAbsolute2(rel) && rel !== ".." && !rel.startsWith(`..${sep2}`);
}
function validateClaudeToolPolicy(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw rejected("tool_policy_invalid", "the tool policy must be an object");
  }
  const record = input;
  if (!Array.isArray(record.allowed_tools)) {
    throw rejected("tool_policy_invalid", "allowed_tools must be an array of tool names");
  }
  const allowed = [];
  for (const entry of record.allowed_tools) {
    if (!validToolName(entry)) {
      throw rejected("tool_policy_invalid", "allowed_tools entries must be non-empty tool name strings");
    }
    if (entry.includes("*")) {
      throw rejected("tool_policy_wildcard", `wildcard tool permissions are never allowed: ${entry}`);
    }
    if (DENIED_BUILTIN_TOOLS.includes(entry)) {
      throw rejected("tool_policy_execution_tool", `execution/edit tools are never auto-approved: ${entry}`);
    }
    if (!PERMITTED_TOOLS.includes(entry)) {
      throw rejected("tool_policy_unknown_tool", `only this project's MCP tools may be auto-approved: ${entry}`);
    }
    if (allowed.includes(entry)) {
      throw rejected("tool_policy_invalid", `duplicated tool permission: ${entry}`);
    }
    allowed.push(entry);
  }
  if (allowed.length !== PERMITTED_TOOLS.length) {
    throw rejected("tool_policy_incomplete", "the frozen five-tool MCP surface must be auto-approved exactly");
  }
  const denied = [];
  if (record.denied_tools !== void 0) {
    if (!Array.isArray(record.denied_tools)) {
      throw rejected("tool_policy_invalid", "denied_tools must be an array of tool names");
    }
    for (const entry of record.denied_tools) {
      if (!validToolName(entry)) {
        throw rejected("tool_policy_invalid", "denied_tools entries must be non-empty tool name strings");
      }
      if (entry.includes("*")) {
        throw rejected("tool_policy_wildcard", `wildcard deny rules could swallow the project MCP surface: ${entry}`);
      }
      if (PERMITTED_TOOLS.includes(entry)) {
        throw rejected("tool_policy_denies_own_surface", `this project's frozen tools may never be denied: ${entry}`);
      }
      denied.push(entry);
    }
  }
  return { allowed_tools: allowed, denied_tools: denied };
}
function resolveRunCwd(config2, run_id) {
  if (typeof run_id !== "string" || !RUN_ID_PATTERN.test(run_id) || run_id.includes("..")) {
    throw rejected("run_id_invalid", "run ids must be simple path-safe identifiers");
  }
  return resolve2(config2.runRoot, run_id);
}
function buildEnv(config2, apiBase) {
  const source = config2.source_env ?? process.env;
  const sourceKeys = /* @__PURE__ */ new Map();
  for (const key of Object.keys(source)) sourceKeys.set(key.toLowerCase(), key);
  const env = {};
  for (const name of config2.envAllowlist) {
    if (!ENV_NAME2.test(name)) throw rejected("env_name_invalid", name);
    if (DENIED_ENV_NAMES[name.toUpperCase()] === true) {
      throw rejected("env_denied", `${name} can inject modules or credentials and is never allowed`);
    }
    const sourceKey = sourceKeys.get(name.toLowerCase());
    const value = sourceKey === void 0 ? void 0 : source[sourceKey];
    if (typeof value === "string") env[name] = value;
  }
  env[API_BASE_ENV] = apiBase;
  return env;
}
function prepareCwd(config2, run_id) {
  const cwd = resolveRunCwd(config2, run_id);
  const canonicalRunRoot = canonicalDir(config2.runRoot, "run_root");
  const canonicalForbidden = [...config2.forbiddenCwdRoots].map((root) => canonicalDir(root, "forbidden_root"));
  mkdirSync(cwd, { recursive: true, mode: 448 });
  const canonicalCwd = realpathSync2(cwd);
  if (!dirContains(canonicalRunRoot, canonicalCwd) || canonicalForbidden.some((root) => dirContains(root, canonicalRunRoot) || dirContains(root, canonicalCwd))) {
    throw rejected("cwd_forbidden", "the run cwd must never be the user repository or workspace");
  }
  return cwd;
}
function buildClaudeLaunchPlan(config2, options) {
  const toolPolicy = validateClaudeToolPolicy(config2.toolPolicy ?? { allowed_tools: PERMITTED_TOOLS });
  const cwd = prepareCwd(config2, options.run_id);
  const { runToken } = options;
  if (typeof runToken !== "string" || runToken.length === 0) {
    throw rejected("token_invalid", "a run-scoped token is required");
  }
  const model = config2.model ?? null;
  if (model !== null && (typeof model !== "string" || !MODEL_PATTERN.test(model))) {
    throw rejected("model_invalid", "model ids and aliases must be simple name-shaped strings");
  }
  assertCommandSpec(config2.command, "command", runToken);
  assertCommandSpec(config2.mcpCommand, "mcp_command", runToken);
  const apiBase = config2.apiBase ?? DEFAULT_API_BASE;
  const env = buildEnv(config2, apiBase);
  const sessionId = config2.sessionId ?? randomUUID();
  if (!SESSION_ID.test(sessionId)) {
    throw rejected("session_id_invalid", "the run session id must be a UUID");
  }
  const mcpConfigPath = join(cwd, "mcp-config.json");
  const mcpServer = {
    name: MCP_SERVER_NAME,
    command: config2.mcpCommand.executable,
    argv: [...config2.mcpCommand.argv],
    env: { [RUN_TOKEN_ENV]: runToken, [API_BASE_ENV]: apiBase }
  };
  writeFileSync(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        [MCP_SERVER_NAME]: { command: mcpServer.command, args: mcpServer.argv, env: mcpServer.env }
      }
    }),
    { mode: 384 }
  );
  const argv = [
    ...config2.command.argv,
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "text",
    "--mcp-config",
    mcpConfigPath,
    "--strict-mcp-config",
    "--tools",
    "",
    "--allowedTools",
    [...toolPolicy.allowed_tools].join(","),
    "--disallowedTools",
    [...DENIED_BUILTIN_TOOLS, ...toolPolicy.denied_tools].join(","),
    "--setting-sources",
    "local",
    "--no-session-persistence",
    "--json-schema",
    CANDIDATE_JSON_SCHEMA,
    ...model === null ? [] : ["--model", model],
    "--session-id",
    sessionId
  ];
  return {
    command: { executable: config2.command.executable, argv },
    cwd,
    env,
    mcpServers: [mcpServer],
    mcpConfigPath,
    toolPolicy,
    model,
    sessionId,
    mode: "run"
  };
}
function buildVersionProbePlan(config2, options) {
  const cwd = prepareCwd(config2, options.run_id);
  assertCommandSpec(config2.command, "command", "");
  return {
    command: { executable: config2.command.executable, argv: [...config2.command.argv, "--version"] },
    cwd,
    env: buildEnv(config2, config2.apiBase ?? DEFAULT_API_BASE),
    mcpServers: [],
    mcpConfigPath: null,
    toolPolicy: validateClaudeToolPolicy({ allowed_tools: PERMITTED_TOOLS }),
    model: config2.model ?? null,
    sessionId: "",
    mode: "version_probe"
  };
}

// apps/agent-host/src/providers/claude/protocol.ts
var SYSTEM_EVENT = "system";
var INIT_SUBTYPE = "init";
var ASSISTANT_EVENT = "assistant";
var USER_EVENT = "user";
var RESULT_EVENT = "result";
var KNOWN_EVENTS = [SYSTEM_EVENT, ASSISTANT_EVENT, USER_EVENT, RESULT_EVENT];
var MAX_TYPE_LENGTH = 128;
function invalid2(detail) {
  return new ProtocolError("invalid_envelope", detail);
}
function parseClaudeLine(line) {
  if (typeof line !== "string") {
    throw new ProtocolError("invalid_line", "event must be a string line");
  }
  if (line.includes("\n") || line.includes("\r")) {
    throw new ProtocolError("multi_line_message", "an event must occupy exactly one line");
  }
  const byteLength4 = Buffer.byteLength(line, "utf8");
  if (byteLength4 > MAX_LINE_BYTES) {
    throw new ProtocolError("message_too_large", `${byteLength4} bytes exceeds the ${MAX_LINE_BYTES} byte limit`);
  }
  let decoded;
  try {
    decoded = JSON.parse(line);
  } catch (error) {
    throw new ProtocolError("invalid_json", error instanceof Error ? error.message : "unparseable line");
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw invalid2("event must be a JSON object");
  }
  const payload = decoded;
  const type = payload.type;
  if (typeof type !== "string" || type.length === 0 || type.length > MAX_TYPE_LENGTH) {
    throw invalid2("event.type must be a non-empty string");
  }
  return {
    kind: KNOWN_EVENTS.includes(type) ? type : "unknown",
    type,
    payload
  };
}

// apps/agent-host/src/providers/claude/session.ts
var MODEL_ALIASES = ["fable", "opus", "sonnet"];
var UNAVAILABLE_REASONS = {
  needs_login: "needs_login",
  model_unavailable: "model_unavailable",
  subscription_unavailable: "subscription_unavailable",
  insufficient_quota: "insufficient_quota",
  api_auth_not_subscription: "api_auth_not_subscription"
};
var AUTH_MODES = { subscription: "subscription", api_key: "api_key" };
var MAX_ID_LENGTH3 = 128;
var MAX_NAME_LENGTH = 128;
var MAX_TURN_PROPOSALS = 1e3;
function validRef(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH3;
}
function validName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_NAME_LENGTH;
}
function recordOf(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value;
}
function withViolation(state, code) {
  return { ...state, violations: [...state.violations, code] };
}
function withPolicyViolation(state, code) {
  return state.policy_violation === null ? { ...state, policy_violation: code } : state;
}
function withBoundaryViolation(state, code) {
  return state.boundary_violation === null ? { ...state, boundary_violation: code } : state;
}
function newClaudeSession(options = {}) {
  return {
    phase: "new",
    run_session_id: options.run_session_id ?? null,
    requested_model: options.requested_model ?? null,
    permitted_tools: options.permitted_tools ?? PERMITTED_TOOLS,
    init: null,
    tool_calls: /* @__PURE__ */ new Map(),
    tool_calls_total: 0,
    tool_result_bytes: 0,
    output_blocks: 0,
    tool_results_seen: 0,
    proposals: [],
    proposal_keys: /* @__PURE__ */ new Set(),
    usage_raw: null,
    usage_folded: false,
    result: null,
    ignored_events: 0,
    duplicate_billing_events: 0,
    violations: [],
    boundary_violation: null,
    policy_violation: null
  };
}
function normalizeClaudeInit(payload) {
  const record = recordOf(payload);
  if (record === null) return null;
  const rawAuth = record.auth_mode;
  if (rawAuth !== void 0 && rawAuth !== null && typeof rawAuth !== "string") return null;
  const auth_mode = typeof rawAuth === "string" && AUTH_MODES[rawAuth] !== void 0 ? AUTH_MODES[rawAuth] : "unknown";
  const rawModel = record.model;
  let model = null;
  if (rawModel !== void 0 && rawModel !== null) {
    if (!validName(rawModel)) return null;
    model = rawModel;
  }
  const rawTools = record.tools;
  let tools = [];
  if (rawTools !== void 0 && rawTools !== null) {
    if (!Array.isArray(rawTools) || rawTools.some((entry) => !validName(entry))) return null;
    tools = [...rawTools];
  }
  const rawServers = record.mcp_servers;
  let mcp_servers = [];
  if (rawServers !== void 0 && rawServers !== null) {
    if (!Array.isArray(rawServers)) return null;
    for (const entry of rawServers) {
      if (validName(entry)) {
        mcp_servers.push(entry);
        continue;
      }
      const server = recordOf(entry);
      if (server === null || !validName(server.name)) return null;
      mcp_servers.push(server.name);
    }
  }
  const rawErrors = record.mcp_server_errors;
  let mcp_server_errors = null;
  if (rawErrors !== void 0 && rawErrors !== null) {
    const errors = recordOf(rawErrors);
    if (errors === null) return null;
    mcp_server_errors = errors;
  }
  return { auth_mode, model, tools, mcp_servers, mcp_server_errors };
}
function classifyClaudeState(state, requestedModel = null) {
  if (state.auth_mode === "api_key") return { availability: "blocked", verification: "not_run" };
  if (state.auth_mode !== "subscription") return { availability: "needs_login", verification: "not_run" };
  if (state.model === null) return { availability: "needs_configuration", verification: "not_run" };
  if (requestedModel !== null && !MODEL_ALIASES.includes(requestedModel) && state.model !== requestedModel) {
    return { availability: "blocked", verification: "not_run" };
  }
  return { availability: "ready", verification: "not_run" };
}
function classifyUnavailable(error) {
  const record = recordOf(error);
  if (record === null) return null;
  const state = record.state;
  if (typeof state !== "string") return null;
  return UNAVAILABLE_REASONS[state] ?? null;
}
function canonicalKey(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalKey).join(",")}]`;
  const record = recordOf(value);
  if (record !== null) {
    const parts = Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalKey(record[key])}`);
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function foldProposalRecords(state, raw) {
  const proposals = [...state.proposals];
  const proposal_keys = new Set(state.proposal_keys);
  for (const proposal of raw) {
    const record = recordOf(proposal);
    if (record === null) continue;
    const key = canonicalKey(record);
    if (proposal_keys.has(key)) continue;
    if (proposals.length >= MAX_TURN_PROPOSALS) continue;
    proposal_keys.add(key);
    proposals.push(record);
  }
  return { ...state, proposals, proposal_keys };
}
function foldProposals(state, raw) {
  return Array.isArray(raw) ? foldProposalRecords(state, raw) : state;
}
function foldSystem(state, payload) {
  if (payload.subtype !== INIT_SUBTYPE) return { ...state, ignored_events: state.ignored_events + 1 };
  const runtime = normalizeClaudeInit(payload);
  if (runtime === null) return { ...state, ignored_events: state.ignored_events + 1 };
  if (state.init !== null) return withViolation(state, "duplicate_init");
  let next = {
    ...state,
    init: runtime,
    phase: state.phase === "result_seen" ? "result_seen" : "running"
  };
  for (const name of runtime.tools) {
    if (!next.permitted_tools.includes(name)) {
      next = withPolicyViolation(next, `tool_not_permitted:${name}`);
    }
  }
  for (const name of runtime.mcp_servers) {
    if (name !== MCP_SERVER_NAME) {
      next = withPolicyViolation(next, `mcp_server_not_permitted:${name}`);
    }
  }
  return next;
}
function foldAssistant(state, payload) {
  const message = recordOf(payload.message);
  const blocks = message !== null && Array.isArray(message.content) ? message.content : null;
  if (blocks === null) return { ...state, ignored_events: state.ignored_events + 1 };
  let next = state;
  let recognized = 0;
  for (const raw of blocks) {
    const block = recordOf(raw);
    if (block === null) continue;
    if (block.type === "text") {
      next = { ...next, output_blocks: next.output_blocks + 1 };
      recognized += 1;
      continue;
    }
    if (block.type !== "tool_use") continue;
    const id = block.id;
    const name = block.name;
    if (!validRef(id) || !validName(name)) continue;
    if (next.tool_calls.has(id)) continue;
    const tool_calls = new Map(next.tool_calls);
    tool_calls.set(id, { tool_use_id: id, name, resolved: false, result_bytes: 0 });
    next = { ...next, tool_calls, tool_calls_total: next.tool_calls_total + 1 };
    recognized += 1;
    if (!next.permitted_tools.includes(name)) {
      next = withPolicyViolation(next, `tool_not_permitted:${name}`);
    }
  }
  return recognized === 0 ? { ...next, ignored_events: next.ignored_events + 1 } : next;
}
function foldUser(state, payload) {
  const message = recordOf(payload.message);
  const blocks = message !== null && Array.isArray(message.content) ? message.content : null;
  if (blocks === null) return { ...state, ignored_events: state.ignored_events + 1 };
  let next = state;
  let recognized = 0;
  for (const raw of blocks) {
    const block = recordOf(raw);
    if (block === null || block.type !== "tool_result") continue;
    const id = block.tool_use_id;
    if (!validRef(id)) continue;
    const call = next.tool_calls.get(id);
    if (call === void 0) {
      next = withBoundaryViolation(next, `unmatched_tool_result:${id}`);
      continue;
    }
    if (call.resolved) {
      next = { ...next, ignored_events: next.ignored_events + 1 };
      continue;
    }
    const result_bytes = JSON.stringify(block).length;
    const tool_calls = new Map(next.tool_calls);
    tool_calls.set(id, { ...call, resolved: true, result_bytes });
    next = {
      ...next,
      tool_calls,
      tool_result_bytes: next.tool_result_bytes + result_bytes,
      tool_results_seen: next.tool_results_seen + 1
    };
    recognized += 1;
  }
  return recognized === 0 ? { ...next, ignored_events: next.ignored_events + 1 } : next;
}
function foldResult(state, payload) {
  if (state.result !== null) {
    const billed = payload.usage !== void 0 && payload.usage !== null;
    return {
      ...state,
      ignored_events: state.ignored_events + 1,
      duplicate_billing_events: state.duplicate_billing_events + (billed ? 1 : 0)
    };
  }
  const error = recordOf(payload.error);
  const status = payload.is_error === true || payload.subtype !== "success" ? "failed" : "success";
  const result = {
    status,
    reason: classifyUnavailable(error),
    error_message: error !== null && typeof error.message === "string" ? error.message : null
  };
  let next = { ...state, phase: "result_seen", result };
  if (payload.usage !== void 0 && payload.usage !== null) {
    next = { ...next, usage_raw: recordOf(payload.usage) ?? {}, usage_folded: true };
  }
  const structured = recordOf(payload.structured_output);
  next = foldProposals(next, structured === null ? void 0 : [structured]);
  if (status === "success") {
    for (const call of next.tool_calls.values()) {
      if (!call.resolved) {
        next = withBoundaryViolation(next, `open_tool_calls_at_result:${call.tool_use_id}`);
        break;
      }
    }
  }
  return next;
}
function foldClaudeMessage(state, event) {
  const sessionRef = event.payload.session_id;
  if (state.run_session_id !== null && sessionRef !== state.run_session_id) {
    if (validRef(sessionRef)) {
      return { ...state, ignored_events: state.ignored_events + 1 };
    }
    if (event.kind === "result") {
      return {
        ...state,
        violations: [...state.violations, "foreign_result_without_session"]
      };
    }
  }
  const withProposals = foldProposals(state, event.payload.proposals);
  if (event.kind === "system") return foldSystem(withProposals, event.payload);
  if (event.kind === "assistant") return foldAssistant(withProposals, event.payload);
  if (event.kind === "user") return foldUser(withProposals, event.payload);
  if (event.kind === "result") return foldResult(withProposals, event.payload);
  return { ...withProposals, ignored_events: withProposals.ignored_events + 1 };
}
function billingTotals(state, pricing = null) {
  if (!state.usage_folded || state.usage_raw === null) return normalizeUsage(null, pricing);
  return normalizeUsage(state.usage_raw, pricing);
}

// apps/agent-host/src/providers/claude/adapter.ts
var DEFAULT_BUDGETS = { max_tool_turns: 32, max_tool_result_bytes: 1048576 };
var CANCEL_DRAIN_MS = 5e3;
function createStdioClaudeTransport(plan) {
  mkdirSync2(plan.cwd, { recursive: true, mode: 448 });
  const policy = {
    trusted_executable_roots: [dirname(resolve3(plan.command.executable))],
    allowed_env: Object.keys(plan.env),
    cwd_root: plan.cwd,
    source_env: {}
  };
  const child = spawnChild(
    { executable: plan.command.executable, argv: [...plan.command.argv], cwd: plan.cwd, env: plan.env },
    policy
  );
  child.stderr.resume();
  const framer = new NdjsonFramer();
  async function* lines() {
    for await (const chunk of child.stdout) {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      for (const line of framer.push(text)) yield line;
    }
    framer.flush();
  }
  return {
    sendPrompt(text) {
      child.stdin.write(text);
      child.stdin.end();
    },
    messages() {
      return lines();
    },
    async close() {
      try {
        child.stdin.end();
      } catch {
      }
      await child.killTree("claude transport close").catch(() => void 0);
    }
  };
}
var MessagePump = class {
  #pending = [];
  #waiters = [];
  #ended = false;
  #failure = null;
  constructor(source) {
    const drain = async () => {
      try {
        for await (const line of source) {
          this.#pending.push(line);
          this.#wake();
        }
      } catch (error) {
        this.#failure = error;
      } finally {
        this.#ended = true;
        this.#wake();
      }
    };
    void drain();
  }
  #wake() {
    while (this.#waiters.length > 0) this.#waiters.shift()();
  }
  async next(options) {
    for (; ; ) {
      if (this.#pending.length > 0) return { kind: "line", line: this.#pending.shift() };
      if (this.#failure !== null) throw this.#failure;
      if (this.#ended) return { kind: "end" };
      if (options.signal.aborted) return { kind: "aborted" };
      if (options.deadlineMs !== null && Date.now() >= options.deadlineMs) return { kind: "timeout" };
      await this.#pause(options);
    }
  }
  async #pause(options) {
    const { promise, resolve: resolve4 } = Promise.withResolvers();
    this.#waiters.push(resolve4);
    const onAbort = () => resolve4();
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) resolve4();
    const timer = options.deadlineMs === null ? void 0 : setTimeout(resolve4, Math.max(1, options.deadlineMs - Date.now()));
    try {
      await promise;
    } finally {
      options.signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    }
  }
};
function errorCodeOf(error) {
  if (error instanceof ProviderError || error instanceof ClaudePermissionError || error instanceof ProtocolError) {
    return error.code;
  }
  if (typeof error === "object" && error !== null) {
    const code = error.code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "adapter_error";
}
function locateExecutable(executable, env) {
  if (typeof executable !== "string" || executable.length === 0) return null;
  if (isAbsolute3(executable) || executable.includes("/") || executable.includes("\\")) {
    return existsSync3(resolve3(executable)) ? resolve3(executable) : null;
  }
  const pathValue = env.PATH ?? env.Path ?? env.path;
  if (typeof pathValue !== "string") return null;
  const extensions = (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter((entry) => entry.length > 0);
  for (const dir of pathValue.split(";")) {
    if (dir.length === 0) continue;
    const candidates = process.platform === "win32" ? extensions.map((extension) => join2(dir, `${executable}${extension}`)) : [join2(dir, executable)];
    for (const candidate of candidates) {
      if (existsSync3(candidate)) return resolve3(candidate);
    }
  }
  return null;
}
function createClaudeLocalAdapter(options) {
  const config2 = options.permissions;
  const pricing = options.pricing ?? null;
  const budgets = { ...DEFAULT_BUDGETS, ...options.budgets ?? {} };
  function composeProfile2(availability, runtimeVersion) {
    return {
      profile_id: "claude_local",
      provider_id: "claude_local",
      // Honest on model identity: the effective model of an installed runtime
      // and account is only observable from an authorized run (T32), never
      // inferred from an alias or an API catalog (ADR 0001).
      model_id: "unknown",
      auth_kind: "official_user_login",
      // image_input is grounded on this project's T21 MCP read_region surface,
      // which returns authorized crops as MCP image content blocks with budget
      // enforcement; no unverified CLI image transport is assumed (T32 gates
      // real image runs).
      capabilities: { image_input: true, tools: true, structured_output: true, bbox_output: false, attributes: true },
      availability,
      verification: "not_run",
      runtime_version: runtimeVersion,
      verified_at: null
    };
  }
  async function launchPlan(run_id) {
    const runToken = await options.runToken(run_id);
    return buildClaudeLaunchPlan(config2, {
      run_id,
      runToken,
      apiBase: config2.apiBase ?? "http://127.0.0.1:48100"
    });
  }
  return {
    async probe() {
      const sourceEnv = config2.source_env ?? process.env;
      if (locateExecutable(config2.command.executable, sourceEnv) === null) {
        return [composeProfile2("needs_configuration", null)];
      }
      const schemaPath = options.schemaArtifactPath ?? null;
      if (schemaPath === null || !existsSync3(schemaPath)) {
        return [composeProfile2("blocked", null)];
      }
      let transport = null;
      try {
        const plan = buildVersionProbePlan(config2, { run_id: "claude-probe" });
        transport = await options.transport(plan);
        const pump = new MessagePump(transport.messages());
        const probeSignal = new AbortController().signal;
        const deadlineMs = Date.now() + (options.probeTimeoutMs ?? 5e3);
        let version = null;
        for (; ; ) {
          const next = await pump.next({ signal: probeSignal, deadlineMs });
          if (next.kind !== "line") break;
          const text = next.line.trim();
          if (version === null && text.length > 0 && text.length <= 64) version = text;
        }
        return [composeProfile2("blocked", version)];
      } catch {
        return [composeProfile2("needs_configuration", null)];
      } finally {
        await transport?.close().catch(() => void 0);
      }
    },
    async *run(input, ctx, signal) {
      const runId = ctx.run_id;
      let seq = 0;
      const emit = (type, message, data) => ({
        run_id: runId,
        seq: seq++,
        type,
        message,
        data
      });
      let terminalSent = false;
      const terminal = (type, message, data) => {
        terminalSent = true;
        return emit(type, message, data);
      };
      const failureData = (code, detail, reason, session3) => {
        const usage = billingTotals(session3, pricing);
        return {
          error_code: code,
          error_message: redactText(detail),
          reason,
          usage,
          cost_display: costDisplay(usage)
        };
      };
      const cancelData = (session3) => {
        const usage = billingTotals(session3, pricing);
        return {
          usage,
          cost_display: costDisplay(usage),
          // A cancelled subscription run may already have been charged; the
          // product never promises a refund or a zero cost here.
          billing: "may_have_cost"
        };
      };
      if (signal.aborted) {
        yield terminal("cancelled", "run cancelled before start", {
          usage: normalizeUsage(null, pricing),
          cost_display: "unknown",
          billing: "not_started"
        });
        return;
      }
      let session2 = newClaudeSession();
      let transport = null;
      try {
        if (input.consent_id === null) {
          yield terminal("failed", "run failed: consent_required", {
            error_code: "consent_required",
            error_message: "no consent record authorizes this run",
            reason: null,
            usage: normalizeUsage(null, pricing),
            cost_display: "unknown"
          });
          return;
        }
        const plan = await launchPlan(runId);
        session2 = newClaudeSession({
          run_session_id: plan.sessionId,
          requested_model: plan.model,
          permitted_tools: plan.toolPolicy.allowed_tools
        });
        if (!("allow_image" in ctx && ctx.allow_image === false)) {
          const grants = imageGrantIds(ctx);
          const source = await options.imageSource(input, runId);
          if (source.grant_id !== grants[0]) throw new ProviderError("image_grant_missing", "image source is not the approved grant");
        }
        const document = await ctx.get_document();
        const ontology = await ctx.get_ontology();
        const domain = {
          intent: input.intent,
          // The claude_local profile never enables bbox_output (C4): no create
          // or geometry changes can come back from this channel.
          bbox_output: false,
          document,
          ontology
        };
        transport = await options.transport(plan);
        const pump = new MessagePump(transport.messages());
        yield emit("started", "run started", null);
        transport.sendPrompt(input.prompt);
        const abortless = new AbortController();
        let cancelling = false;
        let cancelDeadline = null;
        const emittedCalls = /* @__PURE__ */ new Set();
        const runDeadline = options.runTimeoutMs != null && options.runTimeoutMs > 0 ? Date.now() + options.runTimeoutMs : null;
        for (; ; ) {
          const next = await pump.next({
            signal: cancelling ? abortless.signal : signal,
            deadlineMs: cancelling ? cancelDeadline : runDeadline
          });
          if (next.kind === "aborted") {
            cancelling = true;
            cancelDeadline = Date.now() + CANCEL_DRAIN_MS;
            await transport.close().catch(() => void 0);
            continue;
          }
          if (next.kind === "timeout" || next.kind === "end") {
            if (cancelling) {
              const drafts = session2.proposals.map((proposal) => validateCandidateDraft(proposal, domain));
              for (const draft of drafts) {
                await ctx.submit_candidates(draft);
                yield emit("candidate", "candidate submitted", {
                  change_ids: draft.changes.map((change) => change.change_id),
                  issue_ids: draft.issues.map((issue) => issue.issue_id),
                  score: draft.score,
                  context: input.context
                });
              }
              yield terminal("cancelled", "run cancelled; cancellation may already have cost", cancelData(session2));
            } else if (next.kind === "timeout") {
              yield terminal(
                "failed",
                "run failed: tool_time_budget_exceeded",
                failureData("tool_time_budget_exceeded", "the claude tool loop exceeded its time budget", null, session2)
              );
            } else {
              yield terminal(
                "failed",
                "run failed: claude_disconnected",
                failureData("claude_disconnected", "the claude runtime exited before a terminal result", null, session2)
              );
            }
            return;
          }
          const message = parseClaudeLine(next.line);
          const outputBefore = session2.output_blocks;
          const resultsBefore = session2.tool_results_seen;
          session2 = foldClaudeMessage(session2, message);
          if (session2.policy_violation !== null) {
            yield terminal(
              "failed",
              "run failed: method_not_permitted",
              failureData("method_not_permitted", session2.policy_violation, null, session2)
            );
            return;
          }
          if (session2.boundary_violation !== null) {
            yield terminal(
              "failed",
              "run failed: claude_protocol_violation",
              failureData("claude_protocol_violation", session2.boundary_violation, null, session2)
            );
            return;
          }
          if (session2.init !== null) {
            const verdict = classifyClaudeState(session2.init, plan.model ?? null);
            if (session2.init.auth_mode === "api_key") {
              yield terminal(
                "failed",
                "run failed: api_auth_not_subscription",
                failureData(
                  "api_auth_not_subscription",
                  "the runtime authenticated with an API key; this profile is the official subscription channel and an API call is never presented as a subscription run",
                  "api_auth_not_subscription",
                  session2
                )
              );
              return;
            }
            if (verdict.availability === "needs_login") {
              yield terminal(
                "failed",
                "run failed: needs_login",
                failureData(
                  "needs_login",
                  "the runtime did not positively report subscription auth; unknown or absent auth is never presented as a subscription run",
                  "needs_login",
                  session2
                )
              );
              return;
            }
            const loadErrors = session2.init.mcp_server_errors;
            const surfaceMissing = !session2.init.mcp_servers.includes(MCP_SERVER_NAME);
            if (loadErrors !== null && Object.keys(loadErrors).length > 0 || surfaceMissing) {
              yield terminal(
                "failed",
                "run failed: mcp_load_error",
                failureData("mcp_load_error", "the project MCP surface did not load cleanly", null, session2)
              );
              return;
            }
            const reportedModel = session2.init.model;
            if (plan.model !== null && !MODEL_ALIASES.includes(plan.model) && reportedModel !== null && reportedModel !== plan.model) {
              yield terminal(
                "failed",
                "run failed: model_unavailable",
                failureData(
                  "model_unavailable",
                  `the runtime reported model ${reportedModel}, not the requested ${plan.model}`,
                  "model_unavailable",
                  session2
                )
              );
              return;
            }
          }
          if (session2.tool_calls_total > budgets.max_tool_turns) {
            yield terminal(
              "failed",
              "run failed: tool_turn_budget_exceeded",
              failureData("tool_turn_budget_exceeded", "the claude tool loop exceeded its turn budget", null, session2)
            );
            return;
          }
          if (session2.tool_result_bytes > budgets.max_tool_result_bytes) {
            yield terminal(
              "failed",
              "run failed: tool_byte_budget_exceeded",
              failureData("tool_byte_budget_exceeded", "the claude tool loop exceeded its byte budget", null, session2)
            );
            return;
          }
          for (const [id, call] of session2.tool_calls) {
            if (emittedCalls.has(id)) continue;
            emittedCalls.add(id);
            yield emit("tool_call", "tool call", { tool: call.name, tool_use_id: id });
          }
          if (session2.output_blocks > outputBefore) yield emit("progress", "assistant output", null);
          if (session2.tool_results_seen > resultsBefore) yield emit("progress", "tool result", null);
          if (message.kind === "result" && session2.result !== null) {
            if (session2.init === null) {
              yield terminal(
                "failed",
                "run failed: claude_protocol_violation",
                failureData("claude_protocol_violation", "result arrived without a parsed init event", null, session2)
              );
              return;
            }
            if (session2.result.status === "success") {
              const drafts = session2.proposals.map((proposal) => validateCandidateDraft(proposal, domain));
              for (const draft of drafts) {
                await ctx.submit_candidates(draft);
                yield emit("candidate", "candidate submitted", {
                  change_ids: draft.changes.map((change) => change.change_id),
                  issue_ids: draft.issues.map((issue) => issue.issue_id),
                  score: draft.score,
                  context: input.context
                });
              }
              const usage = billingTotals(session2, pricing);
              if (cancelling) {
                yield terminal("cancelled", "run cancelled; cancellation may already have cost", cancelData(session2));
                return;
              }
              yield terminal("succeeded", "run succeeded", {
                usage,
                cost_display: costDisplay(usage),
                model: session2.init.model,
                tool_calls: session2.tool_calls_total
              });
            } else {
              const reason = session2.result.reason;
              const code = reason ?? "provider_reported_failure";
              yield terminal(
                "failed",
                `run failed: ${code}`,
                failureData(code, session2.result.error_message ?? "the claude runtime reported a failed result", reason, session2)
              );
            }
            return;
          }
        }
      } catch (error) {
        if (terminalSent) return;
        const code = errorCodeOf(error);
        const message = error instanceof Error ? redactText(error.message) : "unexpected adapter failure";
        if (signal.aborted) {
          yield terminal("cancelled", "run cancelled; cancellation may already have cost", cancelData(session2));
        } else {
          yield terminal("failed", `run failed: ${code}`, failureData(code, message, null, session2));
        }
      } finally {
        await transport?.close().catch(() => void 0);
      }
    }
  };
}

// apps/agent-host/src/providers/detector-local.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync as writeFileSync2 } from "node:fs";
import { tmpdir } from "node:os";
import { join as join3 } from "node:path";
var RUN_EVENT_TYPES = {
  queued: true,
  started: true,
  progress: true,
  tool_call: true,
  candidate: true,
  succeeded: true,
  failed: true,
  cancelled: true
};
var TERMINAL_EVENTS = { succeeded: true, failed: true, cancelled: true };
var MAX_ID_LENGTH4 = 128;
function composeProfile(modelId, availability, runtimeVersion) {
  return {
    profile_id: "detector_local",
    provider_id: "detector_local",
    model_id: modelId,
    auth_kind: "local_weights",
    capabilities: { image_input: true, tools: false, structured_output: true, bbox_output: true, attributes: false },
    availability,
    // Honest on the verification dimension too: T18 ships mock-tensor
    // post-processing evidence only; live execution evidence is T32's gate.
    verification: "not_run",
    runtime_version: runtimeVersion,
    verified_at: null
  };
}
function errorCode(error) {
  if (error instanceof SpawnPolicyError) return error.code;
  if (error instanceof ProtocolError) return error.code;
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "detector_error";
}
function safeMessage(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim().slice(0, 512);
}
function assertRunEvent(raw, run_id, lastSeq) {
  if (typeof raw !== "object" || raw === null) throw new ProtocolError("invalid_envelope", "run_event payload must be an object");
  const candidate = raw;
  if (candidate.run_id !== run_id) throw new ProtocolError("invalid_envelope", "run_event run_id does not match the run");
  const seq = candidate.seq;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= lastSeq) {
    throw new ProtocolError("invalid_envelope", "run_event seq must be strictly increasing");
  }
  const type = candidate.type;
  if (typeof type !== "string" || RUN_EVENT_TYPES[type] !== true) {
    throw new ProtocolError("invalid_envelope", "run_event has an unknown type");
  }
  if (typeof candidate.message !== "string") throw new ProtocolError("invalid_envelope", "run_event message must be a string");
  const data = candidate.data;
  if (data !== null && (typeof data !== "object" || Array.isArray(data))) {
    throw new ProtocolError("invalid_envelope", "run_event data must be an object or null");
  }
  return {
    run_id,
    seq,
    type,
    message: candidate.message,
    data: data ?? null
  };
}
var DetectorLocalAdapter = class {
  #options;
  #child;
  constructor(options) {
    if (typeof options?.imageSource !== "function") {
      throw new TypeError("DetectorLocalAdapter requires an imageSource binding runs to approved image grants");
    }
    this.#options = options;
    this.#child = {
      executable: options.workerCommand.executable,
      argv: [...options.workerCommand.argv],
      cwd: options.workerCwd
    };
  }
  #modelId() {
    try {
      const lock = JSON.parse(readFileSync(this.#options.lockPath, "utf8"));
      if (typeof lock.model_id === "string" && lock.model_id.length > 0 && lock.model_id.length <= MAX_ID_LENGTH4 * 2) {
        return lock.model_id;
      }
    } catch {
    }
    return "unknown";
  }
  /**
   * Both dimensions are probed honestly. The Python worker probe verifies the
   * pinned weights and the real inference runtime; if the worker cannot even
   * start (Python missing/broken) the channel is `needs_configuration`.
   */
  async probe() {
    const modelId = this.#modelId();
    let child = null;
    try {
      child = spawnChild(this.#child, this.#options.spawnPolicy);
      child.stdin.write(
        `${serializeEnvelope({ protocol_version: PROTOCOL_VERSION, id: "detector-probe", kind: "request", method: "probe", payload: {} })}
`
      );
      child.stdin.end();
      const framer = new NdjsonFramer();
      let profile = null;
      for await (const chunk of child.stdout) {
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        for (const line of framer.push(text)) {
          const envelope = parseEnvelope(line);
          if (envelope.kind === "response" && envelope.method === "probe") {
            const payload = envelope.payload;
            if (payload?.ok === true && typeof payload.profile === "object" && payload.profile !== null) {
              profile = payload.profile;
            }
          }
        }
        if (profile !== null) break;
      }
      await superviseChild(child, { timeoutMs: this.#options.probeTimeoutMs ?? 3e4 });
      if (profile === null) return [composeProfile(modelId, "needs_configuration", null)];
      const availability = profile.availability === "ready" ? "ready" : "needs_configuration";
      const runtimeVersion = typeof profile.runtime_version === "string" ? profile.runtime_version : null;
      const verifiedModelId = typeof profile.model_id === "string" && profile.model_id.length > 0 && profile.model_id.length <= MAX_ID_LENGTH4 * 2 ? profile.model_id : modelId;
      return [composeProfile(verifiedModelId, availability, runtimeVersion)];
    } catch {
      return [composeProfile(modelId, "needs_configuration", null)];
    } finally {
      if (child !== null) {
        await child.killTree("probe cleanup").catch(() => void 0);
      }
    }
  }
  async *run(input, ctx, signal) {
    const runId = ctx.run_id;
    let lastSeq = 0;
    const terminal = (type, message, data = null) => {
      lastSeq += 1;
      return { run_id: runId, seq: lastSeq, type, message, data };
    };
    if (signal.aborted) {
      yield terminal("cancelled", "run cancelled before start");
      return;
    }
    let stageDir = null;
    let child = null;
    const abortHandler = () => {
      if (child !== null) void child.killTree("run aborted").catch(() => void 0);
    };
    signal.addEventListener("abort", abortHandler, { once: true });
    try {
      if (input.intent !== "detect") {
        yield terminal("failed", "the detector only supports detect runs", { code: "unsupported_intent" });
        return;
      }
      const source = await this.#options.imageSource(input, runId);
      const region = await ctx.read_region(source.grant_id, source.region);
      const ontology = await ctx.get_ontology();
      const document = await ctx.get_document();
      const labelMapping = readLabelMapping(this.#options.labelMapPath);
      stageDir = mkdtempSync(join3(tmpdir(), "weblabel-detector-"));
      const imagePath = join3(stageDir, "input.png");
      writeFileSync2(imagePath, region.bytes, { mode: 384 });
      const payload = {
        run_id: runId,
        request: input,
        image: { path: imagePath, transform_to_canonical: region.transform_to_canonical },
        label_mapping: labelMapping,
        ontology_label_ids: ontology.labels.map((label) => label.label_id),
        canonical_size: { width: document.coordinate_space.width, height: document.coordinate_space.height }
      };
      child = spawnChild(this.#child, this.#options.spawnPolicy);
      child.stdin.write(
        `${serializeEnvelope({ protocol_version: PROTOCOL_VERSION, id: runId, kind: "request", method: "start_run", payload })}
`
      );
      const framer = new NdjsonFramer();
      let sawTerminal = false;
      for await (const chunk of child.stdout) {
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        for (const line of framer.push(text)) {
          const envelope = parseEnvelope(line);
          if (envelope.kind !== "event" || envelope.method !== "run_event") continue;
          const event = assertRunEvent(envelope.payload, runId, lastSeq);
          lastSeq = event.seq;
          if (event.type === "candidate") {
            await ctx.submit_candidates(event.data?.raw);
          }
          if (TERMINAL_EVENTS[event.type] === true) {
            sawTerminal = true;
            try {
              child.stdin.end();
            } catch {
            }
          }
          yield event;
        }
      }
      try {
        child.stdin.end();
      } catch {
      }
      const supervised = await superviseChild(child, {
        timeoutMs: this.#options.runTimeoutMs ?? null,
        signal
      });
      if (!sawTerminal) {
        if (supervised.outcome === "cancelled" || signal.aborted) {
          yield terminal("cancelled", "detector run cancelled");
        } else if (supervised.outcome === "timeout") {
          yield terminal("failed", "detector run timed out", { code: "run_timeout" });
        } else {
          yield terminal("failed", "detector worker ended without a terminal event", {
            code: supervised.outcome === "crashed" ? "child_crashed" : "missing_terminal_response"
          });
        }
      }
    } catch (error) {
      yield terminal(signal.aborted ? "cancelled" : "failed", safeMessage(error), signal.aborted ? null : { code: errorCode(error) });
    } finally {
      signal.removeEventListener("abort", abortHandler);
      if (child !== null) {
        await child.killTree("run cleanup").catch(() => void 0);
      }
      if (stageDir !== null) {
        rmSync(stageDir, { recursive: true, force: true });
      }
    }
  }
};
function readLabelMapping(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new SpawnPolicyError("needs_configuration", `explicit label mapping is not readable: ${safeMessage(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SpawnPolicyError("invalid_label_mapping", "label mapping must be a JSON object of category -> label_id");
  }
  const mapping = {};
  for (const [category, labelId] of Object.entries(parsed)) {
    if (typeof labelId !== "string" || labelId.length === 0 || category.length === 0) {
      throw new SpawnPolicyError("invalid_label_mapping", "label mapping must map non-empty categories to non-empty label ids");
    }
    mapping[category] = labelId;
  }
  return mapping;
}

// apps/agent-host/src/runtime/dispatch.ts
function providerDispatch(config2, token2) {
  return async function* (raw, signal) {
    const payload = raw;
    if (!payload?.request || !payload.profile || payload.profile.profile_id !== payload.request.profile_id) throw new RegistryError("invalid_payload");
    if (!payload.execution_profile_config || Array.isArray(payload.execution_profile_config) || typeof payload.execution_profile_config !== "object" || typeof payload.profile_configuration_hash !== "string") throw new RegistryError("invalid_payload");
    const binding = { apiBase: config2.apiBase, token: token2, run_id: payload.run_id, request: payload.request };
    const ctx = await ServerRuntimeContext.open(binding, signal);
    const matches = config2.providers.filter((entry) => entry.provider === payload.profile.provider_id && canonical(entry.config) === canonical(payload.execution_profile_config));
    if (matches.length !== 1 || hasPrivateValues(payload.execution_profile_config)) throw new RegistryError("profile_configuration_changed");
    const selected = { provider: matches[0].provider, config: payload.execution_profile_config };
    const registry = new ProviderRegistry();
    const imageSource = () => {
      if (!ctx.allow_image || ctx.approved_grant_ids.length !== 1) throw new RegistryError("image_grant_missing");
      return { grant_id: ctx.approved_grant_ids[0], region: ctx.approved_image_region };
    };
    for (const [index, entry] of [selected].entries()) {
      switch (entry.provider) {
        case "openai_api":
          registry.register(String(index), createOpenAiApiAdapter({ ...entry.config, secret_env: process.env }));
          break;
        case "anthropic_api":
          registry.register(String(index), createAnthropicApiAdapter({ ...entry.config, secret_env: process.env }));
          break;
        case "mimo_api":
          registry.register(String(index), createMiMoApiAdapter({ ...entry.config, secret_env: process.env }));
          break;
        case "codex_local":
          throw new RegistryError("UNSUPPORTED_RUNTIME", "verified native tool confinement is unavailable for this Codex runtime");
        case "claude_local":
          registry.register(String(index), createClaudeLocalAdapter({ ...entry.config, permissions: { ...entry.config.permissions, apiBase: config2.apiBase, source_env: process.env }, transport: createStdioClaudeTransport, imageSource, runToken: () => token2 }));
          break;
        case "detector_local":
          registry.register(String(index), new DetectorLocalAdapter({ ...entry.config, imageSource }));
          break;
        default:
          throw new RegistryError("unknown_provider");
      }
    }
    const resolved = await registry.resolve(payload.request.profile_id);
    if (resolved.profile.provider_id !== payload.profile.provider_id || resolved.profile.model_id !== payload.profile.model_id || resolved.profile.auth_kind !== payload.profile.auth_kind) throw new RegistryError("profile_configuration_changed");
    const input = ctx.allow_object_context ? payload.request : { ...payload.request, context: { ...payload.request.context, selected_object_ids: [], object_hashes: {} } };
    let lastSeq = -1;
    let terminal = false;
    let events = 0;
    for await (const event of resolved.adapter.run(input, ctx, signal)) {
      if (signal.aborted) return;
      if (++events > 4096 || terminal || event.run_id !== payload.run_id || !Number.isSafeInteger(event.seq) || event.seq <= lastSeq) throw new RegistryError("invalid_provider_protocol");
      lastSeq = event.seq;
      terminal = ["succeeded", "failed", "cancelled"].includes(event.type);
      yield event;
    }
    if (!terminal && !signal.aborted) throw new RegistryError("missing_terminal_response");
  };
}
function canonical(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
}
function hasPrivateValues(value) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => ["secret_env", "source_env", "fetch_impl", "transport", "runToken", "imageSource"].includes(key) || hasPrivateValues(item));
}

// apps/agent-host/src/runtime/main.ts
var configPath = process.env.WEBLABEL_HOST_CONFIG;
var token = process.env.WEBLABEL_RUN_TOKEN;
if (!configPath || !isAbsolute4(configPath) || !token) throw new Error("needs_configuration");
if (statSync2(configPath).size > 1024 * 1024) throw new Error("host_configuration_too_large");
var config = JSON.parse(readFileSync2(configPath, "utf8"));
if (!Array.isArray(config.providers) || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0) throw new Error("invalid_host_configuration");
var session = new HostSession({ registry: new ProviderRegistry(), input: process.stdin, output: process.stdout, logs: process.stderr, spawnPolicy: { trusted_executable_roots: [], allowed_env: [], cwd_root: process.cwd(), source_env: {} }, dispatch: providerDispatch(config, token), runTimeoutMs: config.timeoutMs });
await session.run();
//! Private NDJSON runtime protocol from docs/contracts.md C5.
//!
//! Every line is one message; the stream is hostile input. Oversize lines are
//! rejected BEFORE JSON decode, multi-line payloads are rejected, and every
//! failure is a controlled `ProtocolError` with a stable `code`.
//! Log and protocol-message redaction.
//! Secrets, cookies, authorization headers and image bytes must never appear in
//! logs or protocol messages. Secret *references* (config aliases, env/keyring
//! refs) are configuration, not secrets, and are preserved.
//! Hardened child-process spawning and process-tree reclamation.
//! Policy: shell:false always, only trusted executable paths, argv as a string
//! array (never concatenated shell commands), environment built from an explicit
//! allowlist (never the whole process.env), and a restricted working directory.
//! Windows tree reclamation (exercised on the Windows workstation):
//!   1. snapshot the process table (PowerShell `Get-CimInstance Win32_Process`),
//!      keeping stale parent pids so orphans of a crashed child are still found;
//!   2. `taskkill /pid <root> /T /F` reclaims the live tree, including children
//!      spawned in new process groups (detached);
//!   3. `taskkill /pid <orphan> /F` per surviving descendant from the snapshot;
//!   4. bounded liveness polling for the root and every known descendant.
//! POSIX uses the same snapshot/kill algorithm with `ps` and signals.
//! NDJSON Agent Host session (docs/contracts.md C5).
//! The host speaks the private protocol with its Rust parent on stdio: stdout
//! carries protocol envelopes ONLY, every log line goes to stderr after
//! redaction, and the startup handshake requires a probe request with
//! protocol_version=1. Provider children are launched through the hardened
//! spawn policy; crash, timeout and cancel all reclaim the process tree and a
//! possibly billed run request is never resent automatically.
//! ProviderAdapter registration and probe abstraction (docs/contracts.md C5).
//! Probe results carry two independent dimensions: `availability` (can this
//! channel run at all) and `verification` (what evidence backs it — see
//! docs/provider-compatibility.md). Mock registrations exercise build wiring
//! only; they must never claim real provider identity or live verification.
//! Controlled error taxonomy for the provider HTTP boundary.
//! Everything that can go wrong on the wire, and every contract violation in
//! untrusted provider output (tool arguments, candidate drafts), becomes a
//! `ProviderError` with a stable `code`. Error details are redacted with the
//! T16 redaction rules so secrets never reach logs or run events.
//! Bounded HTTP client for provider API calls.
//! Security posture: the destination base must be the provider's official base
//! or a base explicitly approved by a trusted local administrator; loopback and
//! private-network destinations need an explicit `allow_private_network` grant;
//! redirects are never followed (so an Authorization header can never reach a
//! second location); every request performs exactly one fetch — a timeout or
//! failure is never retried automatically because a POST may already be billed.
//! Image input planning and preparation for provider egress.
//! Two explicit input kinds exist: the full image and per-object crops. Every
//! prepared input carries its canonical transform and a privacy fingerprint
//! (a hash over kind, region, transform and bytes) so logs and run events can
//! reference an image without exposing pixels. Byte and pixel budgets are
//! enforced before anything leaves the process.
//! Usage and cost normalization for provider responses.
//! Unknown usage stays `null` — never zero — and a cost is only ever produced
//! from explicitly configured pricing. Providers that omit usage (MiMo
//! documents `usage: null`) therefore surface `cost_display: 'unknown'`.
//! OpenAI Platform API adapter (Responses API) for `openai_api`.
//! Wire shape follows the provider's own contract (docs/provider-compatibility.md):
//! `POST {base}/responses` with `authorization: Bearer`, `instructions`, typed
//! `input` items carrying `input_image` payloads, flat `function` tools with
//! `strict`, and Responses SSE events (`response.output_item.added`,
//! `response.function_call_arguments.*`, `response.completed`). This is NOT an
//! OpenAI-compatible template shared with the other adapters.
//! Anthropic Platform API adapter (`anthropic_api`).
//! `POST {base}/v1/messages` with `x-api-key` + `anthropic-version` headers, a
//! top-level `system` string, user/assistant content blocks with base64 `image`
//! sources, `input_schema` tools, and Anthropic SSE events (`message_start`,
//! `content_block_*`, `message_delta`, `message_stop`). Tool arguments arrive as
//! `input_json_delta` fragments and tool results return as `tool_result`
//! blocks. This is NOT an OpenAI-compatible template shared with the others.
//! Xiaomi MiMo API adapter (`mimo_api`).
//! Wire shape follows MiMo's own documented contract
//! (docs/provider-compatibility.md): `POST {base}/chat/completions` with Bearer
//! auth, a `system` role message, user content parts carrying `image_url`
//! objects (URL or Base64 data URL, 50 MB per image), function tools wrapped
//! under `function`, SSE chunks and the `[DONE]` sentinel. Documented `usage:
//! null` is preserved as unknown. Token Plan `tp-...` keys must use the exact
//! console-provided base URL — it is never guessed. Tool-call arguments are
//! treated as untrusted (MiMo documents they can be invalid or carry unknown
//! fields) and pass strict schema+domain validation. This is NOT an
//! Hardened launch plan and tool policy for the official Claude Code headless
//! CLI (docs/contracts.md C5, ADR 0001, docs/provider-compatibility.md).
//! PINNED FLAGS: every CLI flag used here is confirmed verbatim by the captured
//! `claude --help` of the installed 2.1.183 runtime (reports/T23/claude-help.txt).
//! Nothing else is ever passed. In particular:
//!   - `--bare` is NEVER used: it drops subscription OAuth and switches to
//!     API-key billing (verified help text), which would disguise an API call
//!     as this subscription channel;
//!   - `--dangerously-skip-permissions` / `--allow-dangerously-skip-permissions`
//!     are NEVER used: the allow/deny policy must stay enforceable;
//!   - built-in tools are disabled entirely (`--tools ""`, verified help text),
//!     only this project's MCP server is loaded (`--mcp-config` +
//!     `--strict-mcp-config`), and only its five C5 semantic tools are
//!     auto-approved (`--allowedTools`), with a deny rule over the execution
//!     surface (`--disallowedTools`);
//!   - user/project settings bleed-through is restricted with
//!     `--setting-sources local` and `--no-session-persistence` (pinned
//!     semantics: T32 must verify which files each source loads);
//!   - the run-scoped MCP token travels via the child environment and the
//!     0600-mode generated MCP config file — never argv, never prompt, never
//!     output; credential environment names can never be allowlisted.
//! The generated MCP config shape (`mcpServers.<name>.{command,args,env}`) is a
//! project pin over the documented `--mcp-config` JSON file form; T32 must
//! validate it against the version-pinned runtime.
//! Claude Code headless stream-json wire protocol (docs/provider-compatibility.md,
//! T02-verified documentation boundaries + `claude --help` of the installed
//! 2.1.183 runtime, captured in reports/T23/claude-help.txt).
//! PINNED SCHEMA (project-side, T32 prerequisite): the event families below are
//! the documented facts (`-p` with `text`/`json`/`stream-json` output,
//! structured output via `--json-schema`, a `system` init event reporting model,
//! tools, MCP servers and load errors). The per-event payload field names
//! consumed by ../session.ts (`message.content` blocks, `session_id`, `usage`,
//! `structured_output`, `proposals`, `error.state`) are PROJECT PINS over those
//! documented families — the installed CLI exposes no schema generator (unlike
//! Codex `app-server generate-*`), so T32 MUST capture real stream-json fixtures
//! from the version-pinned runtime and validate this parser against them.
//! Everything unpinned is tolerated as unknown and can never corrupt state.
//! Client-side Claude Code session state machine (docs/contracts.md C5,
//! docs/provider-compatibility.md).
//! Folds the pinned stream-json event families (init metadata, streaming
//! assistant output, tool_use/tool_result boundaries, the terminal result)
//! without ever letting unexpected or foreign events corrupt state. Tool
//! boundaries are tracked exactly (a tool_result must match a live tool_use; a
//! successful result must not leave calls open), proposals are accumulated and
//! content-deduplicated across all events so a draft seen before the terminal
//! result is never dropped, and the result event's usage is folded at most once
//! so replayed/duplicated results can never double-bill. Unknown usage stays
//! unknown (never 0); cost only comes from explicit pricing.
//! PINNED SCHEMA (project-side, T32 prerequisite): `session_id`, `usage`,
//! `structured_output`, `proposals`, `error.state`, `auth_mode`, `model`,
//! `tools`, `mcp_servers`, `mcp_server_errors` are project pins over the
//! T02-documented event families and must be re-derived from real pinned-runtime
//! fixtures in T32. Every unrecognized method, field or value is tolerated as
//! unknown and ignored — never guessed, never fatal to session state.
//! `claude_local` ProviderAdapter (docs/contracts.md C5): the end user's own
//! official Claude Code subscription runtime in non-interactive `-p` headless
//! mode over stdio, with run-scoped permissions, a project-MCP-only tool
//! surface, an isolated run cwd, consent-gated image egress and honest evidence
//! status.
//! Evidence policy (docs/provider-compatibility.md, ADR 0001):
//!   - probe() reports `needs_configuration` when the official CLI is absent
//!     and `blocked` whenever the channel's protocol/safety boundary is not yet
//!     runtime-verified — the channel is never "ready" from documentation or
//!     synthetic transcripts, and probe() never starts a model session (the
//!     only probe invocation is the verified session-free `--version`);
//!   - `verification` is always `not_run` here: real subscription login, real
//!     image results and pinned-runtime schema validation are T32's gates;
//!   - usage comes from the terminal result only and is folded at most once
//!     (replayed/duplicated results can never double-bill), unknown usage stays
//!     unknown (never 0), cost is only computed from explicit pricing, and
//!     cancellation reports that it may already have cost — never a refund;
//!   - the tool loop is bounded by turns, bytes and time;
//!   - candidates always carry the original run context (C4) and are only ever
//!     produced through `ctx.submit_candidates` after strict schema+domain
//!     validation — truncated, failed or confused streams never write
//!     annotations.
//! Authentication posture (ADR 0001, task card behavior 2): the run uses the
//! user's official Claude Code login as-is. The adapter never logs in, never
//! reads, collects or relays credentials, never passes `--bare` (which switches
//! to API-key billing), and credential environment names can never be
//! allowlisted into the child. An API-key-authenticated runtime is a distinct
//! `api_auth_not_subscription` failure, and a runtime that does not positively
//! report `auth_mode: 'subscription'` is refused as `needs_login` — absent or
//! unknown auth is never treated as subscription success. A result without a
//! parsed init is a protocol violation. An API call is never disguised as a
//! successful subscription run.
//! Optional local CPU detector provider adapter (RT-DETR v2, contracts C4/C5).
//! The adapter drives the Python worker (`python -m weblabel_detector`) over
//! the private NDJSON protocol. Evidence policy (task card T18):
//!   - probe() reports `needs_configuration` when the Python runtime or the
//!     pinned weights are missing; `verification` is always `not_run` from T18
//!     because mock-tensor tests are not evidence and real weight execution is
//!     T32's gate;
//!   - runs produce candidates through `ctx.submit_candidates` only — the
//!     adapter never writes AnnotationRevision or document state;
//!   - image bytes never travel inside protocol lines: the run's approved image
//!     grant is staged to a private temp file for the worker and deleted after.
//! Manual annotation is independent of this adapter: when the detector is not
//! configured, probe() still succeeds and reports the missing configuration.
