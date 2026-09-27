# T15 manual smoke: human annotation vertical slice

This procedure uses a local authenticated WebLabel instance and no model, model weights, provider credentials, or external calls. It is deliberately not a claim of success until each observed API/UI result is recorded.

## Prepare deterministic input

1. Start the API and web app using the project's supported local startup procedure.
2. Create a project named `T15 manual smoke`; publish one `Person` label (`label_id=label_person`) with optional `helmet_state` enum values `wearing`, `not_wearing`, `unknown` and default `unknown`.
3. Create 20 PNG images, each 320×240, using the deterministic pattern and coordinate table below. Each has a contrasting rectangle baked into the pixels; boxes are ground-truth test coordinates, not pre-loaded annotation objects.
4. Import all 20 using the visible media-import file input. Confirm the API's project asset list contains 20 processed image revisions. Also import `tests/fixtures/media/orientation-6.jpg` and `orientation-2.jpg` for canonical direction checks.

| file | expected canonical xyxy | orientation | canonical dimensions |
|---|---:|---:|---:|
| `t15-demo-01.png` … `t15-demo-20.png` | for zero-based `i`: `[24+(i mod 5)*31, 20+floor(i/5)*39, 54+(i mod 5)*31, 72+floor(i/5)*39]` | 1 | 320×240 |
| `orientation-6.jpg` | `[4,5,20,30]` | 6 | source height × source width |
| `orientation-2.jpg` | `[6,4,30,25]` | mirrored | source width × source height |

The procedural PNG input has a 16px checkerboard background with a differently colored solid expected-object rectangle. Use the same loop and RGB values as `generatedImage` in `tests/e2e/fixtures.ts`; do not hand-adjust the expected coordinates.

## Browser actions and evidence

1. Log in through the UI, create/open the project, and import media through the real file picker. Verify the GPU diagnostic says `actual_backend=webgpu`, `device_state=ready`, and a hardware adapter. Any software adapter is a failure, not a fallback.
2. Open `t15-demo-01.png`, choose the rectangle tool, draw a box over the contrasting region, choose label `Person`, set `helmet_state=wearing`, and wait for the explicit synchronized-save state.
3. Before reloading, GET `/api/assets/{asset_revision_id}/annotation?ontology_version_id={ontology_version_id}`. Record the revision ID, completion, object label, attributes, and full continuous-pixel `bbox_xyxy` numbers. Reload the page, GET the same endpoint again, and require identical revision/document values.
4. Export that saved revision as COCO. Save the downloaded bytes and run `python scripts/check-dataset-loader.py <downloaded-file> --label label_person --xyxy <x_min> <y_min> <x_max> <y_max>`. The parser must report the exact category mapping and canonical xyxy derived from COCO's xywh values.
5. Select a fresh image. Choose `confirmed_negative`; ensure the UI requires a distinct confirmation action before saving. Confirm, wait for synchronized state, reload, and verify a normal API GET says `completion=confirmed_negative` and `objects=[]`.
6. For EXIF 6 and mirrored input, compare the canonical image endpoint's decoded pixels/dimensions with the known transformed source and verify the visible canvas shows that canonical image. Draw a known canonical box, save, reload, export, and independently read back the exact same canonical coordinates. No orientation transform or DPR factor is allowed in persisted geometry.

## Expected report contents

Keep API JSON responses and downloaded media/export bytes local to the test run; the checked-in T15 report may retain only synthetic-data hashes, exact coordinate assertions, browser screenshots/traces, adapter identity, command/exit status, and test counts. Do not include session cookies, CSRF values, bootstrap codes, or user data.
