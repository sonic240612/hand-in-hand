$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$distributionRoot = Join-Path $projectRoot 'dist'
$agentPackageRoot = Join-Path $distributionRoot 'hand-in-hand-agent'
$agentSourceRoot = Join-Path $agentPackageRoot 'src'
New-Item -ItemType Directory -Path $agentSourceRoot -Force | Out-Null
foreach ($sourceName in @('agent.mjs', 'codex-rpc.mjs', 'codex-runtime.mjs', 'session.mjs', 'workspace.mjs')) {
    Copy-Item -LiteralPath (Join-Path (Join-Path $projectRoot 'src') $sourceName) -Destination (Join-Path $agentSourceRoot $sourceName) -Force
}
$agentPackageJson = @'
{
  "name": "hand-in-hand-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": { "agent": "node src/agent.mjs" }
}
'@
[System.IO.File]::WriteAllText((Join-Path $agentPackageRoot 'package.json'), $agentPackageJson, [System.Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $projectRoot 'AGENT-README.md') -Destination (Join-Path $agentPackageRoot 'README.md') -Force
Compress-Archive -Path $agentPackageRoot -DestinationPath (Join-Path $distributionRoot 'hand-in-hand-agent.zip') -Force
Write-Output (Join-Path $distributionRoot 'hand-in-hand-agent.zip')
