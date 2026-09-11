$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$distributionRoot = Join-Path $projectRoot 'dist'
$stagingRoot = Join-Path $distributionRoot ('agent-package-' + [guid]::NewGuid().ToString('N'))
$agentPackageRoot = Join-Path $stagingRoot 'hand-in-hand-agent'
$agentSourceRoot = Join-Path $agentPackageRoot 'src'
New-Item -ItemType Directory -Path $agentSourceRoot -Force | Out-Null
foreach ($sourceName in @('agent.mjs', 'codex-rpc.mjs', 'codex-runtime.mjs', 'session.mjs', 'workspace.mjs', 'exec-transport.mjs', 'interactions.mjs')) {
    Copy-Item -LiteralPath (Join-Path (Join-Path $projectRoot 'src') $sourceName) -Destination (Join-Path $agentSourceRoot $sourceName) -Force
}
$rootManifest = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$agentManifest = [ordered]@{ name=$rootManifest.name; version=$rootManifest.version; private=$true; type='module'; engines=$rootManifest.engines; scripts=@{agent='node src/agent.mjs'}; dependencies=$rootManifest.dependencies } | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText((Join-Path $agentPackageRoot 'package.json'), $agentManifest, [System.Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $projectRoot 'package-lock.json') -Destination (Join-Path $agentPackageRoot 'package-lock.json') -Force
$localGuide = Join-Path $projectRoot 'AGENT-README.md'
if (Test-Path -LiteralPath $localGuide) {
    Copy-Item -LiteralPath $localGuide -Destination (Join-Path $agentPackageRoot 'README.md') -Force
} else {
    $basicGuide = @'
# hand-in-hand agent

Requires Node.js 22+, Codex CLI signed in with your ChatGPT account, and a host invitation.
Run `npm ci`, then `npm run agent -- --host HOST_URL` and enter your pairing code.
Keep the connector running while you work. Add `--resume` to reconnect later.
Use the same Tailscale host URL as your browser. Keep `.hih-agent` private.
'@
    [System.IO.File]::WriteAllText((Join-Path $agentPackageRoot 'README.md'), $basicGuide, [System.Text.UTF8Encoding]::new($false))
}
Compress-Archive -Path $agentPackageRoot -DestinationPath (Join-Path $distributionRoot 'hand-in-hand-agent.zip') -Force
$resolvedStagingRoot = [System.IO.Path]::GetFullPath($stagingRoot)
$resolvedDistributionRoot = [System.IO.Path]::GetFullPath($distributionRoot) + [System.IO.Path]::DirectorySeparatorChar
if (-not $resolvedStagingRoot.StartsWith($resolvedDistributionRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Package staging path is outside dist.' }
Remove-Item -LiteralPath $resolvedStagingRoot -Recurse -Force
Write-Output (Join-Path $distributionRoot 'hand-in-hand-agent.zip')
