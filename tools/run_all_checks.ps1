$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $repoRoot

function Invoke-Check {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Name,

    [Parameter(Mandatory = $true)]
    [string[]] $Command
  )

  Write-Host ""
  Write-Host "== $Name =="

  $exe = $Command[0]
  $commandArgs = @()
  if ($Command.Count -gt 1) {
    $commandArgs = $Command[1..($Command.Count - 1)]
  }

  & $exe @commandArgs
  if ($LASTEXITCODE -ne 0) {
    throw "$Name failed with exit code $LASTEXITCODE"
  }
}

$jsFiles = @(
  'js\app.js',
  'js\config.js',
  'js\coordinates.js',
  'js\dom-utils.js',
  'js\layer-state.js',
  'js\monster-utils.js',
  'js\search-utils.js',
  'tools\deploy_smoke.mjs',
  'tests\deploy_smoke.test.mjs',
  'tests\project_workflow.test.mjs',
  'tests\pure_utils.test.mjs',
  'tests\search_layer_regression.mjs'
)

foreach ($file in $jsFiles) {
  Invoke-Check "Syntax check $file" @('node', '--check', $file)
}

Invoke-Check 'Pure utility unit tests' @('node', '--test', 'tests\pure_utils.test.mjs')
Invoke-Check 'Deploy smoke unit tests' @('node', '--test', 'tests\deploy_smoke.test.mjs')
Invoke-Check 'Project workflow contract tests' @('node', '--test', 'tests\project_workflow.test.mjs')
Invoke-Check 'Search layer regression' @('node', 'tests\search_layer_regression.mjs')
Invoke-Check 'Map update unittest' @('python', '-m', 'unittest', 'tests.test_run_map_update_checks')
Invoke-Check 'Map update health check' @('python', 'tools\run_map_update_checks.py')

Write-Host ""
Write-Host "All local checks passed."
