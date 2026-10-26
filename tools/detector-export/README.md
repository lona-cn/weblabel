# RT-DETRv2 offline developer conversion

This is a development tool, not a Python product fallback. It uses only the existing pinned weights and synthetic images. The native product runs its own Rust `detector-worker` process with ORT CPU. Source identities and third-party notices are under the detector model metadata directory.

## Prerequisites and safety gate

Use CPython 3.12 and the exact five versions in `requirements.txt`. The isolated environment prepared for this rebuild is `target/tools/detector-export/venv`; cache/temp and the authorized ORT archive are also project-local. `prepare.py --metadata` checks official wheel metadata without importing a model. `prepare.py --runtime` downloads only the explicitly authorized Windows x64 ORT 1.23.2 archive and verifies its pinned SHA before extraction. It never loads a DLL/model or runs inference. The runtime installation receipt includes DLL, license, and third-party-notice hashes.

Main must first run:

```text
target/tools/detector-export/venv/Scripts/python.exe tools/detector-export/test_controls.py
```

The six controls include actual fixed-version Torch legacy export of a tiny, no-weights toy module. Its separate CONTROL ledger is not the authorized detector ledger. Missing dependencies fail, not skip. The other cases cover process exclusion, durable precharge, failure accounting, exhaustion, and corruption. No control imports detector weights.

Main's six no-model meter controls passed after the Windows leaf-handle fix; retain both the initial failure and passing receipts. They do not authorize detector execution by themselves. A second **processor-only** gate is REQUIRED before creating any authorized ledger or loading a detector model:

```text
target/tools/detector-export/venv/Scripts/python.exe tools/detector-export/preprocess.py --weights-dir services/detector/weights --weblabel-binary <real-weblabel.exe> --output-dir target/test-artifacts/html-rust-rebuild/<new-unique>/processor-only
```

This generates all six tensors with the original `AutoImageProcessor` default backend, then calls the real Rust executable's existing NDJSON `probe` method. It loads no model/ORT, consumes no detector forward, and requires byte-exact tensor hashes; it preserves every mismatch and fails nonzero. The original backend is Transformers5.17's TorchvisionBackend. Main's processor-only probe disproved the earlier Pillow22-bit assumption in all six images. Rust now ports Torch2.14's axis-global int16 coefficient quantization and float32 rescale multiplication; do not change the original backend or relax equality.

Only after **both** no-model gates pass may Main create **one new authorized ledger** and explicitly start measured conversion. Do not reset, replace, or use another ledger after a failure. Initialization refuses an existing file:

```text
python tools/detector-export/budget.py --create target/test-artifacts/html-rust-rebuild/r05-authorized/forward-ledger.json --max-forwards 20
```

The parent directory must already exist. All paths must resolve within the fixed project root. Never point tests or conversion at a user's live data directory. Existing weights are read-only. Model loads use `local_files_only=True` and offline/telemetry-disabled environment settings. A file size/hash mismatch refuses loading.

## Explicit measured commands

```text
python tools/detector-export/export.py --weights-dir services/detector/weights --output-dir target/test-artifacts/html-rust-rebuild/<unique>/detector --budget-ledger target/test-artifacts/html-rust-rebuild/r05-authorized/forward-ledger.json --max-forwards 20

python tools/detector-export/verify.py --weights-dir services/detector/weights --model-dir target/test-artifacts/html-rust-rebuild/<unique>/detector --weblabel-binary <real-weblabel.exe> --budget-ledger target/test-artifacts/html-rust-rebuild/r05-authorized/forward-ledger.json --max-forwards 20 --report-dir target/test-artifacts/html-rust-rebuild/<new-unique>/detector-equivalence
```

Output/report targets must be new. Failures preserve diagnostics. Export publishes a manifest only after full ONNX checking; that manifest explicitly says equivalence `not_run`. Export is fixed to `dynamo=False`, opset 18, no external data, fixed float32 input `[1,3,640,640]`, logits `[1,300,80]`, and normalized boxes `[1,300,4]`. No quantization, dynamic axes, decoder changes, hand-edited IR, or exporter fallback is permitted. Unsupported ops or actual IR >11 block the task.

The top-level model pre-hook persists a debit before every model invocation, including implicit exporter traces. The hook returns `None`, preserving Torch arguments. A failed invocation still spends its debit. Verification charges a `rust-request` receipt **before spawning/sending each inference request**; the worker atomically redeems it once before native inference. Receipt replay is rejected. Neither path warms up or retries.

Verification requires 18 remaining forwards: six Python forwards, six same-tensor Rust forwards, and six ordinary-image Rust forwards. Export's implicit calls use the same 20-total ledger; if fewer than 18 remain, verification refuses before model load. The six processor goldens cover RGB, alpha, wide/tall aspect, mirror, and rotation. All ordinary-image worker tensors must match the original processor golden SHA byte-for-byte. Same-tensor raw outputs must meet `atol=rtol=1e-4`, exact retained query/category/label sets, and canonical bbox error <=0.1 pixel. The threshold remains 0.5 even at a boundary discrepancy.

`equivalence.json` and per-case raw outputs/receipts are the evidence. A failure does not publish a passing report or alter the derived model. Do not auto-run another verification attempt. Empty detections can prove execution/equivalence, but not detection quality, nonempty candidate acceptance, undo/save, T32, or redistribution approval.

## Current Main evidence and inference stop

The six baseline meter controls and all six byte-exact processor cases passed. The actual fixed-strategy export completed with one charged forward; its graph is IR 8/opset 18, SHA256 `ddeed4c0b5d5a2686fb69dae892590b76a13dce1b319ca89d84a6e0e6a9c14c7`. This is an export result, not numeric equivalence.

The first comparison stopped before native Session creation: `ort::info()` returns `GetBuildInfoString`, not the semantic runtime version. The worker now queries `OrtGetApiBase.GetVersionString` from the already-loaded, hash-checked module and requires exact `1.23.2`. Main's temporary DLL/environment-only diagnostic observed actual `1.23.2`; it created no Session/model/ticket and ran no detector forward. The diagnostic plus three byte-validation controls passed; the temporary diagnostic was then removed.

The only authorized ledger remains `target/test-artifacts/html-rust-rebuild/r05-authorized/forward-ledger.json`, frozen at **3/20 debits**: one export forward, one Python reference forward, and one redeemed native request that failed before Session/inference. The user explicitly stopped further detector inference. Do not resume, create a replacement ledger, increase the limit, rerun export/verification, or reinterpret the failed debit as free.

Additional verifier controls do not replace those six meter controls. Runtime-file closure preflight passed. The real Windows file-symlink negative case could not create its link (`Win1314`); the single authorized UAC attempt was cancelled before its child started. This proof remains blocked, not skipped or passed, and no elevation retry is authorized. Full numeric equivalence, nonempty candidate quality and R05 completion remain unproved. Actual logs are under `reports/T35/html-rust-rebuild/r05-*`; the preserved failed comparison is under the authorized artifact directory.


## Product integration boundary

The worker consumes one bounded NDJSON v1 `start_run` request and exits after one response. Image and tensor bytes are confined, hash-checked files, not base64 inside a protocol line. The worker does not initialize SQLite, read user credentials, or mutate annotations. The parent singleton pool allows one native inference and eight waiting jobs and supports queued cancellation. Product dispatch uses the shared token store's atomic `dispatch_if_live` callback and R04's pre-execution owned Windows Job, not bare PID/PPID cleanup. Explicit cleanup proves Job ActiveProcesses0 before releasing admission. Unexpected Future drop closes the kill-on-close Job and poisons admission because cleanup was not explicitly verified. End-user product execution has no permanent development 20-forward limit.

The actual `detector::execute` RunDriver adapter reloads and authorizes before dispatch and after return, compares the selected execution hash separately from the consent-envelope hash, and obtains image/crop bytes solely through AgentToolService. It freezes and validates trusted category mappings against the run's ontology, preserves integer crop/transform identity, revokes on cancellation/deadline, and cleans its private run artifacts. Ordinary product Image requests do not copy/serialize raw outputs. Candidate payloads enter the existing RunDriver prediction/quarantine funnel, never revisions directly; real completion emits Rust/ORT CPU/model/mapping receipts with unknown/null fees. Main's fixed provider match only needs to compose this entry. See the scoped R05 integration report for exact signatures and Main-owned Cargo/CLI/token-store/native-process wiring.

No model, ONNX, runtime binary, or private configuration belongs in Git/default release. Include the PyTorch and upstream Pillow resampling notices in assembled releases, and include ORT's own LICENSE/ThirdPartyNotices when assembling an optional runtime. Linux execution, the new native preprocessing gate, and real model equivalence were not exercised by the R05 implementation agent.
