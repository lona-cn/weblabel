$env:TEMP='D:/workspace/src/weblabel/target/defect-repair/2026-10-11T13-21-39-234Z/live-igr'
$env:TMP=$env:TEMP
$env:WEBLABEL_TEST_REPORT_DIR='D:/workspace/src/weblabel/target/defect-repair/2026-10-11T13-21-39-234Z/live-igr/test-output'
& 'D:/workspace/src/weblabel/target/t31-node-runtime-v24.16.0/node-v24.16.0-win-x64/node.exe' 'D:/workspace/src/weblabel/node_modules/vitest/vitest.mjs' run --config 'target/defect-repair/2026-10-11T13-21-39-234Z/live-igr/vitest.config.mjs' --testNamePattern 'offline consumer|four synthetic consumer|same-byte source|interrupt aborts' --reporter=json --outputFile 'target/worktrees/live-evidence-proposal/reports/T32/defect-repair/2026-10-11T13-21-39-234Z/igr-fix/vitest-first.json'
exit $LASTEXITCODE
