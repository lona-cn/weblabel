# T00 Compatibility Matrix

All versions below were queried or executed on this workstation on 2026-09-25. This records toolchain availability/build checks only, not product or GPU acceptance.

| Component | Pinned value | Evidence / status |
|---|---|---|
| OS target | Windows x64, MSVC | Rust target `x86_64-pc-windows-msvc` is installed. |
| Node.js | 24.15.0 | Exact version pinned in `.node-version`, `package.json` engines, and CI. |
| pnpm | 10.34.5 | Exact stable v10 release; Node engine `>=18.12`, verified on Node 24.15.0. `pnpm run doctor` executes the app diagnostic. Direct `pnpm doctor` is reserved by pnpm 12 and does not dispatch the package script under pnpm 10 either; use `pnpm run doctor`. |
| Rust | 1.96.0 (`x86_64-pc-windows-msvc`) | `rustc --version`; stable toolchain installed and pinned in `rust-toolchain.toml`. |
| Rust WASM target | `wasm32-unknown-unknown` | Installed for pinned Rust toolchain. |
| wgpu | 30.0.1 | Exact dependency in `renderer-wgpu/Cargo.toml`; wasm compilation check required. |
| wasm-pack | 0.15.0 | Exact CLI version checked by the browser probe build. |
| wasm-bindgen CLI | 0.2.128 | Exact CLI version checked by the browser probe build; matches the pinned Rust dependency. |
| Browser / GPU | Playwright Chromium 153.0.8010.12 | Browser-side adapter/device request ran with WebGPU enabled and SwiftShader selected, but Chromium reported no suitable adapter. `pnpm test:e2e` passed the explicit blocked-diagnostic path; `pnpm test:gpu:software` correctly failed because no device initialized. No hardware or software-GPU acceptance. |
| OMP | 18.3.0 | `omp --version`; effective `task.isolation.enabled=true`, backend `auto`, apply `true`, merge `patch`, concurrency `4`, recursion depth `1` from `omp config list --json`. Project `.omp/config.yml` specifies matching task defaults. |

T00 adds only pinned development test tools (Vitest 5.0.1, Playwright 1.63.0), not product runtime dependencies. The Node stdio test uses a bootstrap-only probe, not the production Agent Host/provider. The browser fixture calls the exported wasm-bindgen WebGPU adapter/device initializer. Its development WASM build uses wasm-pack `--dev`: the bundled `wasm-opt` rejected Rust bulk-memory opcodes on an initial release build, so no optimized-build or performance claim is made. `pnpm-lock.yaml` and `Cargo.lock` are generated from the exact manifests. The workstation exposes no browser adapter; software-device CI remains unverified and hardware acceptance is blocked.
