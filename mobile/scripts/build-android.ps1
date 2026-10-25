<#
.SYNOPSIS
  Build the Veda Android APK on Windows.

.DESCRIPTION
  Windows limits paths to 260 characters, and the React Native C++ build nests the full source path inside its own
  output path, so building from this repo's deep location fails ("ninja: error: mkdir ... No such file or directory").
  This script mirrors the project to a SHORT folder, builds there, and copies the APK back to mobile\apk\.
  The repo stays the source of truth: the mirror is rebuilt from it on every run (node_modules and android\ are kept
  in the mirror between runs so later builds are fast).

.PARAMETER Variant
  debug (default) or release. Both are signed with the debug key, which is fine for sideloading, not for the Play Store.

.PARAMETER Clean
  Regenerate the native android\ project from app.json (needed after changing plugins or permissions).

.PARAMETER Arch
  CPU type to compile native code for. arm64-v8a (default) covers practically every phone since 2016 and builds about
  four times faster than 'all'. Use x86_64 for the Android emulator.

.PARAMETER Work
  The short mirror folder. Keep it under about 25 characters.

.EXAMPLE
  powershell -File mobile\scripts\build-android.ps1 -Variant release
#>
param(
  [ValidateSet('debug', 'release')][string]$Variant = 'debug',
  [switch]$Clean,
  [ValidateSet('arm64-v8a', 'armeabi-v7a', 'x86_64', 'all')][string]$Arch = 'arm64-v8a',
  [string]$Work = 'C:\Users\prave\dev\vm'
)

$ErrorActionPreference = 'Stop'
$src = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

if (-not $env:JAVA_HOME) { $env:JAVA_HOME = [Environment]::GetEnvironmentVariable('JAVA_HOME', 'User') }
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = [Environment]::GetEnvironmentVariable('ANDROID_HOME', 'User') }
if (-not (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe'))) { throw "JAVA_HOME is not set or wrong: '$env:JAVA_HOME'" }
if (-not (Test-Path $env:ANDROID_HOME)) { throw "ANDROID_HOME is not set or wrong: '$env:ANDROID_HOME'" }
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
if ($Work.Length -gt 25) { Write-Warning "The work folder path is long ($($Work.Length) chars); the C++ build may fail on Windows." }

Write-Host "==> Mirroring $src -> $Work"
New-Item -ItemType Directory -Force $Work | Out-Null
robocopy $src $Work /MIR /XD node_modules android ios .expo dist apk .git .cxx build /XF *.apk /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }

Push-Location $Work
try {
  # Reinstall when the lock file changed since the last install, so a new dependency never builds against a stale node_modules.
  $lockHash = (Get-FileHash 'package-lock.json').Hash
  $stamp = 'node_modules\.lock-hash'
  $installed = (Test-Path $stamp) -and ((Get-Content $stamp -Raw).Trim() -eq $lockHash)
  if (-not (Test-Path 'node_modules') -or -not $installed) {
    Write-Host '==> Installing dependencies (npm ci)'
    npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    Set-Content -Path $stamp -Value $lockHash
  }

  if ($Clean -or -not (Test-Path 'android')) {
    Write-Host '==> Generating the native Android project (expo prebuild)'
    if ($Clean) { npx expo prebuild --platform android --no-install --clean } else { npx expo prebuild --platform android --no-install }
    if ($LASTEXITCODE -ne 0) { throw 'expo prebuild failed' }
    if (-not (Test-Path 'android')) { throw 'expo prebuild finished but produced no android folder' }
  } else {
    # app.json may have changed: re-apply it without wiping the native build cache
    npx expo prebuild --platform android --no-install | Out-Null
  }

  Write-Host "==> Gradle assemble$($Variant.Substring(0,1).ToUpper() + $Variant.Substring(1))"
  Push-Location 'android'
  try {
    $task = if ($Variant -eq 'release') { 'assembleRelease' } else { 'assembleDebug' }
    # Not passed as -PreactNativeArchitectures=...: gradlew.bat is a batch file and cmd splits its arguments at '='.
    if ($Arch -ne 'all') {
      $props = Get-Content 'gradle.properties'
      $props = $props | ForEach-Object { if ($_ -match '^reactNativeArchitectures=') { "reactNativeArchitectures=$Arch" } else { $_ } }
      Set-Content 'gradle.properties' $props
    }
    & .\gradlew.bat $task --console=plain
    if ($LASTEXITCODE -ne 0) { throw "gradle $task failed (exit $LASTEXITCODE)" }
  } finally { Pop-Location }

  $apk = Get-ChildItem "android\app\build\outputs\apk\$Variant" -Filter *.apk | Select-Object -First 1
  if (-not $apk) { throw 'Build finished but no APK was found.' }
  $out = Join-Path $src 'apk'
  New-Item -ItemType Directory -Force $out | Out-Null
  $dest = Join-Path $out "veda-$Variant.apk"
  Copy-Item $apk.FullName $dest -Force
  Write-Host ("==> Done: {0} ({1:N1} MB)" -f $dest, ($apk.Length / 1MB))
} finally { Pop-Location }
