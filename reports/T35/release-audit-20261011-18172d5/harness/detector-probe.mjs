// apps/agent-host/src/providers/detector-local.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const byteLength = utf8ByteLength(line);
  if (byteLength > MAX_LINE_BYTES) {
    throw new ProtocolError("message_too_large", `${byteLength} bytes exceeds the ${MAX_LINE_BYTES} byte limit`);
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
  const byteLength = utf8ByteLength(line);
  if (byteLength > MAX_LINE_BYTES) {
    throw new ProtocolError("message_too_large", `${byteLength} bytes exceeds the ${MAX_LINE_BYTES} byte limit`);
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
  let canonical;
  try {
    canonical = realpathSync(target);
  } catch {
    throw new SpawnPolicyError(`${label}_missing`, target);
  }
  return canonical;
}
function isUnderAny(target, roots) {
  return roots.some((root2) => {
    let canonicalRoot;
    try {
      canonicalRoot = realpathSync(root2);
    } catch {
      throw new SpawnPolicyError("trusted_root_missing", root2);
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
  const { promise, resolve: resolve2 } = Promise.withResolvers();
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve2({ code: child.exitCode, signal: child.signalCode });
  } else {
    child.once("exit", (code, signal) => resolve2({ code, signal }));
  }
  return promise;
}
function delay(ms) {
  const { promise, resolve: resolve2 } = Promise.withResolvers();
  setTimeout(resolve2, ms);
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
  const { promise, resolve: resolve2 } = Promise.withResolvers();
  const child = spawnProcess(executable, argv, {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore"]
  });
  child.once("error", () => resolve2(null));
  child.once("exit", (code) => resolve2(code));
  return promise;
}
function parseProcessTable(output) {
  const records = /* @__PURE__ */ new Map();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*(\S*)\s*$/.exec(line);
    if (!match) continue;
    const pid2 = Number(match[1]);
    const created = match[3] === "" ? null : Date.parse(match[3]);
    records.set(pid2, {
      ppid: Number(match[2]),
      created_ms: Number.isNaN(created) ? null : created
    });
  }
  return records;
}
function snapshotProcessTable() {
  const result2 = process.platform === "win32" ? spawnSync(
    systemTool("powershell.exe"),
    [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToUniversalTime().ToString('o'))" }`
    ],
    { encoding: "utf8", windowsHide: true }
  ) : spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  return parseProcessTable(result2.stdout ?? "");
}
function findDescendants(rootPid, table) {
  const found = [];
  const queue = [rootPid];
  const seen = /* @__PURE__ */ new Set([rootPid]);
  while (queue.length > 0) {
    const current = queue.shift();
    for (const [pid2, record] of table) {
      if (record.ppid !== current || seen.has(pid2)) continue;
      seen.add(pid2);
      found.push(pid2);
      queue.push(pid2);
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
async function reclaimProcessTree(root2, reason) {
  const cutoffMs = Date.now();
  const table = snapshotProcessTable();
  const rootRecord = table.get(root2.root_pid);
  const rootIsOurs = rootRecord === void 0 || rootRecord.created_ms === null || rootRecord.created_ms <= root2.spawned_at_ms;
  const lineageUpperMs = root2.exited_at_ms ?? cutoffMs;
  const descendants = findDescendants(root2.root_pid, table).filter((pid2) => {
    const record = table.get(pid2);
    if (record?.created_ms == null) return true;
    return record.created_ms >= root2.spawned_at_ms && record.created_ms <= lineageUpperMs;
  });
  const targets = [
    ...rootIsOurs ? [root2.root_pid] : [],
    ...descendants
  ].map((pid2) => ({ pid: pid2, created_ms: table.get(pid2)?.created_ms ?? null }));
  const mechanism = process.platform === "win32" ? "windows taskkill /T + CIM descendant sweep (creation-time identity checked)" : "posix signal sweep (ps snapshot + SIGKILL; ps exposes no creation time, so creation identity is unavailable on POSIX)";
  if (process.platform === "win32") {
    if (rootIsOurs) {
      await runTool(systemTool("taskkill.exe"), ["/pid", String(root2.root_pid), "/T", "/F"]);
    }
    for (const target of targets) {
      if (target.pid === root2.root_pid) continue;
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
    const alive2 = targets.filter((target) => stillSameProcess(target, snapshotProcessTable()));
    if (alive2.length === 0) break;
    if (Date.now() >= deadline) {
      throw new SpawnPolicyError("reclaim_incomplete", `${reason}: pids still alive after reclaim: ${alive2.map((t) => t.pid).join(",")}`);
    }
    await delay(250);
  }
  return {
    root_pid: root2.root_pid,
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
  const pid2 = child.pid;
  const started_at_ms = Date.now();
  const exited = exitPromise(child);
  return {
    pid: pid2,
    started_at_ms,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    wait: () => exited,
    killTree: (reason) => reclaimProcessTree({ root_pid: pid2, spawned_at_ms: started_at_ms }, reason)
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

// apps/agent-host/src/providers/detector-local.ts
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
var MAX_ID_LENGTH2 = 128;
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
      if (typeof lock.model_id === "string" && lock.model_id.length > 0 && lock.model_id.length <= MAX_ID_LENGTH2 * 2) {
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
      const verifiedModelId = typeof profile.model_id === "string" && profile.model_id.length > 0 && profile.model_id.length <= MAX_ID_LENGTH2 * 2 ? profile.model_id : modelId;
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
      stageDir = mkdtempSync(join(tmpdir(), "weblabel-detector-"));
      const imagePath = join(stageDir, "input.png");
      writeFileSync(imagePath, region.bytes, { mode: 384 });
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

// target/build-cache/release-audit-20261011/detector-probe.ts
import fs from "node:fs";
import { spawnSync as spawnSync2 } from "node:child_process";
var root = "D:/workspace/src/weblabel";
var scratch = root + "/target/build-cache/release-audit-20261011";
var nodeDir = root + "/target/t31-node-runtime-v24.16.0/node-v24.16.0-win-x64";
var pidPath = scratch + "/silent-worker.pid";
fs.rmSync(pidPath, { force: true });
var adapter = new DetectorLocalAdapter({ spawnPolicy: { trusted_executable_roots: [nodeDir], allowed_env: ["SystemRoot", "TEMP", "TMP"], cwd_root: scratch }, workerCommand: { executable: nodeDir + "/node.exe", argv: [scratch + "/silent-worker.cjs"] }, workerCwd: scratch, lockPath: scratch + "/nonexistent-lock.json", labelMapPath: scratch + "/nonexistent-map.json", imageSource: () => {
  throw Error("No images authorized or used");
}, probeTimeoutMs: 50 });
var start = performance.now();
var settled = false;
var result;
var pending = adapter.probe().then((r) => {
  settled = true;
  result = r;
}, (e) => {
  settled = true;
  result = { error: String(e) };
});
await new Promise((r) => setTimeout(r, 500));
var elapsed = performance.now() - start;
var pid = fs.existsSync(pidPath) ? Number(fs.readFileSync(pidPath, "utf8")) : null;
var alive = () => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
var evidence = { fixture: "silent local NDJSON worker; NO real detector, model load, network, accounts or images", configured_probe_timeout_ms: 50, external_watchdog_ms: 500, observed_elapsed_ms: elapsed, settled_before_cleanup: settled, pid, worker_alive_before_cleanup: alive(), cleanup: null, result: null, worker_alive_after_cleanup: false };
if (pid && alive()) {
  const k = spawnSync2("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8" });
  evidence.cleanup = { exit_code: k.status, stdout: k.stdout, stderr: k.stderr };
}
await Promise.race([pending, new Promise((r) => setTimeout(r, 1e3))]);
evidence.result = result ?? null;
evidence.worker_alive_after_cleanup = alive();
fs.writeFileSync(root + "/reports/T35/release-audit-20261011-18172d5/detector-probe.json", JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
if (!pid || evidence.worker_alive_after_cleanup) throw Error("Unsafe/invalid probe cleanup");
//! Private NDJSON runtime protocol from docs/contracts.md C5.
//!
//! Every line is one message; the stream is hostile input. Oversize lines are
//! rejected BEFORE JSON decode, multi-line payloads are rejected, and every
//! failure is a controlled `ProtocolError` with a stable `code`.
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
