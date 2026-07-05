$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $repoRoot
$repoRootPath = $repoRoot.Path

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

$jsFiles = Get-ChildItem -Path 'js', 'tools', 'tests' -Recurse -File -Include '*.js', '*.mjs' |
  Sort-Object FullName |
  ForEach-Object { $_.FullName.Substring($repoRootPath.Length + 1) }

foreach ($file in $jsFiles) {
  Invoke-Check "Syntax check $file" @('node', '--check', $file)
}

$pythonFiles = Get-ChildItem -Path 'tools' -Filter '*.py' |
  Sort-Object Name |
  ForEach-Object { Join-Path 'tools' $_.Name }
Invoke-Check 'Python tool syntax' (@('python', '-m', 'py_compile') + $pythonFiles)

Invoke-Check 'Pure utility unit tests' @('node', '--test', 'tests\pure_utils.test.mjs')
Invoke-Check 'Deploy smoke unit tests' @('node', '--test', 'tests\deploy_smoke.test.mjs')
Invoke-Check 'Project workflow contract tests' @('node', '--test', 'tests\project_workflow.test.mjs')
Invoke-Check 'Search layer regression' @('node', 'tests\search_layer_regression.mjs')
Invoke-Check 'Map update unittest' @('python', '-m', 'unittest', 'tests.test_run_map_update_checks')

Write-Host ""
Write-Host "All CI checks passed."
