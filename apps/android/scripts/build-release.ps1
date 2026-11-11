<#
.SYNOPSIS
  Builds the signed, minified (R8) release APK of the check-in app on Windows (PowerShell).

.DESCRIPTION
  Runs the :core and app unit tests, builds app-release.apk, verifies the signature with apksigner
  and prints path, size and SHA-256. Optionally installs the APK on a USB-connected phone.

  Signing data comes from apps/android/keystore.properties (git-ignored) or from the environment
  variables TIX_KEYSTORE_FILE, TIX_KEYSTORE_PASSWORD, TIX_KEY_ALIAS, TIX_KEY_PASSWORD.
  The Android SDK is found via ANDROID_HOME, local.properties or the default install location.

.EXAMPLE
  .\scripts\build-release.ps1 -VersionName 1.0.0 -VersionCode 1
.EXAMPLE
  .\scripts\build-release.ps1 -VersionName 1.0.1 -VersionCode 2 -Install
#>
param(
  [Parameter(Mandatory = $true)][string]$VersionName,
  [Parameter(Mandatory = $true)][int]$VersionCode,
  [switch]$Install
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot   # apps/android
Set-Location $root

if ($VersionName -notmatch '^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$') { throw 'VersionName must look like 1.2.0' }
if ($VersionCode -lt 1) { throw 'VersionCode must be a positive integer (higher than the previous release)' }

# --- signing data: keystore.properties or TIX_* environment variables -------------------------
$props = @{}
$propsFile = Join-Path $root 'keystore.properties'
if (Test-Path $propsFile) {
  foreach ($line in Get-Content $propsFile) {
    if ($line -match '^\s*([^#=\s]+)\s*=\s*(.*)$') { $props[$Matches[1]] = $Matches[2].Trim() }
  }
}
function SigningValue($prop, $envName) {
  if ($props.ContainsKey($prop) -and $props[$prop]) { return $props[$prop] }
  return [Environment]::GetEnvironmentVariable($envName)
}
$storeFile = SigningValue 'storeFile' 'TIX_KEYSTORE_FILE'
foreach ($pair in @(@('storeFile', 'TIX_KEYSTORE_FILE'), @('storePassword', 'TIX_KEYSTORE_PASSWORD'),
    @('keyAlias', 'TIX_KEY_ALIAS'), @('keyPassword', 'TIX_KEY_PASSWORD'))) {
  if (-not (SigningValue $pair[0] $pair[1])) {
    throw "Missing signing value '$($pair[0])' (keystore.properties) / $($pair[1]) (environment). See apps/android/README.md."
  }
}
if (-not [System.IO.Path]::IsPathRooted($storeFile)) { $storeFile = Join-Path $root $storeFile }
if (-not (Test-Path $storeFile)) { throw "Keystore not found: $storeFile" }

# --- build ----------------------------------------------------------------------------------
& .\gradlew.bat --console=plain :core:test :app:testDebugUnitTest :app:assembleRelease `
  "-Ptix.versionName=$VersionName" "-Ptix.versionCode=$VersionCode"
if ($LASTEXITCODE -ne 0) { throw "Gradle build failed (exit $LASTEXITCODE)" }

$apk = Join-Path $root 'app\build\outputs\apk\release\app-release.apk'
if (-not (Test-Path $apk)) { throw 'Release APK was not produced (is the signing data correct?)' }

# --- locate the SDK (env, local.properties written by the Gradle build) ----------------------
$sdk = $env:ANDROID_HOME
if (-not $sdk -and (Test-Path (Join-Path $root 'local.properties'))) {
  $line = Get-Content (Join-Path $root 'local.properties') | Where-Object { $_ -match '^sdk\.dir=' } | Select-Object -First 1
  if ($line) { $sdk = ($line -replace '^sdk\.dir=', '') -replace '\\:', ':' -replace '\\\\', '\' }
}

# --- verify signature -----------------------------------------------------------------------
if ($sdk -and (Test-Path (Join-Path $sdk 'build-tools'))) {
  $bt = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory |
    Sort-Object { [version]($_.Name -replace '[^0-9.].*$', '') } | Select-Object -Last 1
  $signer = Join-Path $bt.FullName 'apksigner.bat'
  if (Test-Path $signer) {
    & $signer verify --print-certs $apk 2>$null | Select-String 'certificate (DN|SHA-256)'
    & $signer verify $apk 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Signature verification FAILED' }
    Write-Host 'signature: OK'
  }
}

$hash = (Get-FileHash $apk -Algorithm SHA256).Hash.ToLower()
Write-Host ''
Write-Host "APK:      $apk"
Write-Host "version:  $VersionName ($VersionCode)"
Write-Host "size:     $((Get-Item $apk).Length) bytes"
Write-Host "sha256:   $hash"

# --- optional: install on a USB-connected phone ------------------------------------------------
if ($Install) {
  $adb = if ($sdk) { Join-Path $sdk 'platform-tools\adb.exe' } else { 'adb' }
  & $adb devices
  & $adb install -r $apk
  if ($LASTEXITCODE -ne 0) {
    throw 'adb install failed. Is USB debugging enabled and the phone authorised? If an older build signed with a different key is installed, uninstall it first: adb uninstall org.tix.checkin'
  }
  Write-Host 'Installed on the connected device.'
}

Write-Host ''
Write-Host 'Next: Admin -> Check-in devices -> Scanner app -> Upload a new version (same version name and code).'
