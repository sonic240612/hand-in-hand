$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'package-agent.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
