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
Copy-Item -LiteralPath (Join-Path $projectRoot 'AGENT-README.md') -Destination (Join-Path $agentPackageRoot 'README.md') -Force
Compress-Archive -Path $agentPackageRoot -DestinationPath (Join-Path $distributionRoot 'hand-in-hand-agent.zip') -Force
$resolvedStagingRoot = [System.IO.Path]::GetFullPath($stagingRoot)
$resolvedDistributionRoot = [System.IO.Path]::GetFullPath($distributionRoot) + [System.IO.Path]::DirectorySeparatorChar
if (-not $resolvedStagingRoot.StartsWith($resolvedDistributionRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Package staging path is outside dist.' }
Remove-Item -LiteralPath $resolvedStagingRoot -Recurse -Force
Write-Output (Join-Path $distributionRoot 'hand-in-hand-agent.zip')
