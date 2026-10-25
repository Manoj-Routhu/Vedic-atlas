<#
Runs the unit tests and the router evals for one checkout and prints a one-table summary, so two checkouts (for example
main and a feature branch) can be compared side by side.

  .\scripts\run_regression.ps1 -Tag branch
  .\scripts\run_regression.ps1 -Tag main -Root C:\path\to\worktree-of-main -Python .\.venv\Scripts\python.exe
  .\scripts\run_regression.ps1 -Tag quick -SkipClean            # skip the 346-case set
  .\scripts\run_regression.ps1 -Tag smoke -CleanLimit 40        # a sample of the big set

Needs the Veda server STOPPED (the evals load their own copy of the model). Full output of every run is kept in
<Root>\tests\eval\results\regression-<Tag>\ ; the summary table is also written there as summary.txt.
#>
param(
    [string]$Tag = "run",
    [string]$Root = (Resolve-Path "$PSScriptRoot\..").Path,
    [string]$Python = (Join-Path (Resolve-Path "$PSScriptRoot\..").Path ".venv\Scripts\python.exe"),
    [switch]$SkipClean,
    [int]$CleanLimit = 0,
    [switch]$SkipTests
)

$ErrorActionPreference = "Continue"
$out = Join-Path $Root "tests\eval\results\regression-$Tag"
New-Item -ItemType Directory -Force $out | Out-Null
Set-Location $Root
$env:PYTHONPATH = Join-Path $Root "src"      # a worktree must import ITS OWN code, not the editable install's
$env:PYTHONUNBUFFERED = "1"

$rows = @()

if (-not $SkipTests) {
    Write-Host "== unit tests" -ForegroundColor Cyan
    & $Python -m pytest -q --ignore=tests/test_vector_store.py -p no:cacheprovider 2>&1 | Tee-Object "$out\pytest.txt" | Select-Object -Last 3
    $line = (Select-String -Path "$out\pytest.txt" -Pattern "passed|failed|error" | Select-Object -Last 1).Line
    $rows += [pscustomobject]@{ Set = "pytest"; Result = $line; Detail = "" }
}

$sets = @(
    @{ Name = "golden"; File = "tests\eval\orchestrator_golden.yaml" },
    @{ Name = "heldout"; File = "tests\eval\orchestrator_heldout.yaml" },
    @{ Name = "edge"; File = "tests\eval\orchestrator_edge.yaml" }
)
if (-not $SkipClean) { $sets += @{ Name = "clean"; File = "tests\eval\orchestrator_clean.yaml" } }

foreach ($s in $sets) {
    Write-Host "== eval: $($s.Name)" -ForegroundColor Cyan
    $args = @("scripts\spike_decision_protocol.py", "--variants", "A5", "--golden", $s.File)
    if ($s.Name -eq "clean" -and $CleanLimit -gt 0) { $args += @("--limit", "$CleanLimit") }
    & $Python @args 2>&1 | Tee-Object "$out\$($s.Name).txt" | Where-Object { $_ -match "^===|decision ms|^\s+failures" }
    $result = (Select-String -Path "$out\$($s.Name).txt" -Pattern "^=== A5" | Select-Object -Last 1).Line
    $timing = (Select-String -Path "$out\$($s.Name).txt" -Pattern "decision ms" | Select-Object -Last 1).Line
    $rows += [pscustomobject]@{ Set = $s.Name; Result = ("$result").Trim(); Detail = ("$timing").Trim() }
}

Write-Host "`n==================== SUMMARY ($Tag) ====================" -ForegroundColor Green
$rows | Format-Table -AutoSize -Wrap | Out-String -Width 220 | Tee-Object "$out\summary.txt"
Write-Host "Details: $out"
