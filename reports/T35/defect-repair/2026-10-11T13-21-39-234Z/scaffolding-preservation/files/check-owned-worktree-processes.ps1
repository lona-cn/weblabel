$ErrorActionPreference='Stop'
$root='D:\workspace\src\weblabel'
$names=@('node','cargo','rustc','wasm-pack','wasm-bindgen','weblabel-api','link')
$owned=@()
$unresolvedNamed=@()
Get-Process -Name $names -ErrorAction SilentlyContinue | ForEach-Object {
  try { $p=$_.Path; if ($p -like ($root+'\target\worktrees\*')) { $owned += [PSCustomObject]@{Id=$_.Id;StartTime=$_.StartTime.ToUniversalTime().ToString('o');Path=$p} } } catch { $unresolvedNamed += $_.Exception.GetType().FullName }
}
$json=[PSCustomObject]@{observed_at=[DateTime]::UtcNow.ToString('o');owned_worktree_executable_paths=$owned;metadata_errors=$unresolvedNamed;scope='Only relevant native executable paths, not private command line parameters; historical native-close/service evidence remains required.'} | ConvertTo-Json -Depth 5; [System.IO.File]::WriteAllText('D:/workspace/src/weblabel/reports/T35/defect-repair/2026-10-11T13-21-39-234Z/cleanup-preservation/owned-worktree-process-path-observation.json',$json,[System.Text.UTF8Encoding]::new($false))
$owned | ConvertTo-Json -Depth 4
