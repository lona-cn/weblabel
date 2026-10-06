# Security model

This guide is for operators and engineers extending WebLabel. Its purpose is to help them preserve the final authorization boundaries and distinguish local engineering evidence from official-runtime or live-model verification.

## Scope and trust

WebLabel defaults to loopback deployment. A local administrator controls execution profiles and may explicitly approve an exact provider base. That approval is not permission for redirects, arbitrary tools, additional filesystem roots, or unrelated project data.

Images, image text, prompts, model responses, tool arguments, archives, URLs and browser request headers are untrusted. Model output remains a proposal; it cannot approve a human review or become an annotation simply because a provider requested it. Browser sessions and run capabilities are different authorities.

Synthetic tests use their own databases, images, temporary files and loopback servers. Their results do not attest to a paid account, an official CLI's sandbox, hardware WebGPU or production model quality.

## HTTP and session boundary

| Boundary | Required authority | Refusal behavior |
| --- | --- | --- |
| Browser API | Exact configured Host; allowed Origin when required; active user session | An attacker-controlled Host or Origin is refused before protected work. |
| Session-authenticated mutation | Active session plus matching CSRF token | Missing or invalid CSRF is refused, including login when an active cookie is present. |
| Login after an invalid or expired cookie | Fresh username/password, valid Host and Origin | Session inspection returns 401 and expires the stale cookie. Fresh credential login can recover without the old CSRF token. Wrong credentials remain refused. |
| Session lookup storage failure | Working authentication store | A storage failure is an error, not permission to treat a session as absent. |
| Run tools | Exact Host/Origin policy and an unexpired, unrevoked run-scoped bearer capability | A capability is not a browser session and cannot authorize human approval or access another run/project. |

The stale-cookie recovery exception applies only when no active principal exists. It does not weaken Origin/Host validation or the CSRF rule for a live session. Expiring a stale cookie uses the same strict, HttpOnly cookie boundary as normal authentication.

Do not pass project or run identity through arbitrary tool arguments. The server obtains it from the issued capability and persisted run context. Cancellation revokes further tool access. A foreign user's run/media lookup must not reveal protected project data.

## Explicit external-processing approval

External processing requires the project's policy, a preview of actual inputs, and the user's consent to that preview. The approval binds the annotation content and configured execution profile. A later content revision or profile/model change requires a new preview and consent; an old approval must not enqueue the changed work.

Use an ordinary persisted synthetic profile when testing profile mutation. The reserved built-in mock profile is intentionally fixed and is not a substitute for a configurable provider. Production profiles must not present mock output as verified provider output.

## Files, imports and exports

Filesystem grants refer to approved files under an approved staging root. Resolution must check the real path, not just the apparent path: a directory junction or symlink cannot extend a grant to an outside file. Reject traversal, absolute or drive-relative Windows paths, and UNC inputs. Check project/run binding again when a grant is used; revocation must invalidate access.

Archive extraction separately rejects traversal and absolute paths, symlink entries, case-insensitive name collisions and entries exceeding resource budgets. A safe archive control is required alongside malicious examples so a test does not merely prove that every archive is rejected. An invalid annotation import must leave the annotation head and import transaction state unchanged.

Image headers are not trusted allocation instructions. Decode failures, including extreme claimed dimensions, must produce a failed import job without a successful asset.

Dataset export uses a fixed, human-approved revision. Exported archive members must contain that revision and its approved image, not private profile credentials or neighboring files. Tests inspect the actual downloaded ZIP, including decoded members; checking only a response flag is insufficient.

## Provider transport and credentials

An administrator's approval is bound to the exact provider base. Unapproved loopback, metadata, foreign-domain and non-HTTP endpoints are refused before network access. Any provider redirect is refused, for both ordinary and streaming requests. Authorization belongs to the initial approved request and must never be forwarded to a redirect target.

Tests may name a metadata address as a redirect target but must not contact it. A safety guard must observe the production request's `redirect: manual` setting rather than override it; otherwise it could conceal a regression.

Resolved credentials are private runtime inputs. Error diagnostics can be hostile: a provider may echo a key without a recognizable prefix or label. Redact exact resolved values before emitting a failed run event, in addition to generic header/token/key pattern redaction. Preserve the failure classification and nonsecret diagnostic context. Do not rely solely on an `sk-` prefix or a `Bearer` label.

Production scans build the API executable, browser JavaScript/CSS/WASM, Agent Host bundles and sourcemaps with a fresh synthetic credential sentinel supplied only as private environment values. They scan actual output bytes and build/runtime logs. This proves that the exercised sentinel was not embedded; it is not a universal detector for every possible credential format.

## Injection and final tool permissions

The local hostile-provider scenario sends a real PNG with the printed instruction to read `.secret`, run a shell and approve annotations, plus the same hostile text prompt. A synthetic loopback provider returns each forbidden tool call through a valid streaming response. The actual Host rejects it, and separate direct requests verify the final API refusal.

The allowlist and argument schema remain authoritative even if a model follows every injected instruction. Unknown tools are refused. A path smuggled into a permitted image-reading tool is refused. A bearer capability cannot call the human-review endpoint. Rejected calls must not create predictions, change annotation content, execute a shell or expose credentials. MCP must repeat argument validation and propagate an authoritative expired-token refusal.

## Verification channels and release gate

Run `pnpm test:task T29` for the complete engineering attack suite. Keep the full logs, exit codes and collected test counts; filtered reproduction runs are not substitutes for the unfiltered gate. Run the affected type, formatting and generated-contract checks and the production artifact scan.

The official Codex production dispatch currently fails closed as `UNSUPPORTED_RUNTIME`. A passing refusal test demonstrates that no fake official runtime was launched; it does not demonstrate a supported official sandbox. No real Codex/Claude account, paid model or live external endpoint is used by T29. Any official runtime that cannot constrain its extra filesystem or shell access remains an external release blocker for that profile and cannot pass T32 through engineering evidence alone.

Mock/local synthetic model transport, in-memory MCP transport, software GPU, hardware GPU and live model evidence must be reported separately. T29's in-memory MCP test still talks to the real HTTP authorization boundary, but is not official-CLI evidence. Windows junction behavior and archive symlink-entry rejection are exercised locally; an OS-native symbolic-link test on another platform requires a separate run on that platform.
