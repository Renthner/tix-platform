<#
.SYNOPSIS
  Builds the signed, minified (R8) release APK of the check-in app on Windows (PowerShell).

.DESCRIPTION
  Runs the :core and app unit tests, builds app-release.apk, verifies the signature with apksigner
  and prints path, size and SHA-256. Optionally installs the APK on a USB-connected phone.

  Signing data comes from apps/android/keystore.properties (git-ignored) or from the environment
  variables TIX_KEYSTORE_FILE, TIX_KEYSTORE_PASSWORD, TIX_KEY_ALIAS, TIX_KEY_PASSWORD. Missing values
  are asked interactively (the password is not echoed and never written to disk); the key password
  defaults to the keystore password. -CreateKeystore creates %USERPROFILE%\tix-keys\tix-checkin.jks
  with keytool (from Android Studio's JBR) if it does not exist yet.
  The Android SDK is found via ANDROID_HOME, local.properties or the default install location.

.EXAMPLE
  .\scripts\build-release.ps1 -VersionName 1.0.0 -VersionCode 1 -CreateKeystore
.EXAMPLE
  .\scripts\build-release.ps1 -VersionName 1.0.0 -VersionCode 1
.EXAMPLE
  .\scripts\build-release.ps1 -VersionName 1.0.1 -VersionCode 2 -Install
#>
param(
  [Parameter(Mandatory = $true)][string]$VersionName,
  [Parameter(Mandatory = $true)][int]$VersionCode,
  [switch]$Install,
  [switch]$CreateKeystore
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
$defaultStore = Join-Path $env:USERPROFILE 'tix-keys\tix-checkin.jks'
$interactive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected

# --- optional: create the keystore (keytool asks for the password and your name itself) -------
if ($CreateKeystore) {
  $target = SigningValue 'storeFile' 'TIX_KEYSTORE_FILE'
  if (-not $target) { $target = $defaultStore }
  if (-not [System.IO.Path]::IsPathRooted($target)) { $target = Join-Path $root $target }
  if (Test-Path $target) {
    Write-Host "Keystore already exists, nothing created: $target"
  } else {
    $keytool = $null
    foreach ($dir in @($env:JAVA_HOME, (Join-Path $env:ProgramFiles 'Android\Android Studio\jbr'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Android Studio\jbr'))) {
      if ($dir -and (Test-Path (Join-Path $dir 'bin\keytool.exe'))) { $keytool = Join-Path $dir 'bin\keytool.exe'; break }
    }
    if (-not $keytool) {
      $cmd = Get-Command keytool -ErrorAction SilentlyContinue
      if ($cmd) { $keytool = $cmd.Source }
    }
    if (-not $keytool) { throw 'keytool not found. Install Android Studio or set JAVA_HOME to its jbr folder.' }
    New-Item -ItemType Directory -Force (Split-Path -Parent $target) | Out-Null
    $newAlias = SigningValue 'keyAlias' 'TIX_KEY_ALIAS'
    if (-not $newAlias) { $newAlias = 'tix' }
    Write-Host "Creating keystore $target (alias '$newAlias'). Choose a password and remember it."
    & $keytool -genkeypair -v -keystore $target -alias $newAlias -keyalg RSA -keysize 4096 -validity 10000
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $target)) { throw 'keytool failed, no keystore was created.' }
    Write-Host ''
    Write-Host "Keystore created: $target"
    Write-Host 'BACK IT UP NOW (and its password): without this file and password no update can ever be installed over existing devices.'
    Write-Host ''
  }
  if (-not $env:TIX_KEYSTORE_FILE) { $env:TIX_KEYSTORE_FILE = $target }
  if (-not $env:TIX_KEY_ALIAS -and -not $props.ContainsKey('keyAlias')) { $env:TIX_KEY_ALIAS = 'tix' }
}

# --- missing values: ask (interactive) or fail; passwords are only kept in this process -------
function Ask($prompt, $default) {
  $answer = Read-Host $(if ($default) { "$prompt [$default]" } else { $prompt })
  if ($answer) { return $answer.Trim() }
  return $default
}
function AskSecret($prompt) {
  $secure = Read-Host $prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
if (-not (SigningValue 'storeFile' 'TIX_KEYSTORE_FILE') -and $interactive) {
  $env:TIX_KEYSTORE_FILE = Ask 'Keystore file' $(if (Test-Path $defaultStore) { $defaultStore } else { $null })
}
if (-not (SigningValue 'keyAlias' 'TIX_KEY_ALIAS') -and $interactive) {
  $env:TIX_KEY_ALIAS = Ask 'Key alias' 'tix'
}
if (-not (SigningValue 'storePassword' 'TIX_KEYSTORE_PASSWORD') -and $interactive) {
  $env:TIX_KEYSTORE_PASSWORD = AskSecret 'Keystore password (not shown)'
}
# A PKCS12 keystore (keytool default) uses one password for store and key.
if (-not (SigningValue 'keyPassword' 'TIX_KEY_PASSWORD') -and (SigningValue 'storePassword' 'TIX_KEYSTORE_PASSWORD')) {
  $env:TIX_KEY_PASSWORD = SigningValue 'storePassword' 'TIX_KEYSTORE_PASSWORD'
}
$storeFile = SigningValue 'storeFile' 'TIX_KEYSTORE_FILE'
foreach ($pair in @(@('storeFile', 'TIX_KEYSTORE_FILE'), @('storePassword', 'TIX_KEYSTORE_PASSWORD'),
    @('keyAlias', 'TIX_KEY_ALIAS'), @('keyPassword', 'TIX_KEY_PASSWORD'))) {
  if (-not (SigningValue $pair[0] $pair[1])) {
    throw "Missing signing value '$($pair[0])' (keystore.properties) / $($pair[1]) (environment). Run with -CreateKeystore once, or see apps/android/README.md."
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
    # apksigner prints a harmless JDK warning on stderr; Windows PowerShell 5.1 would turn it into an error.
    $ErrorActionPreference = 'Continue'
    & $signer verify --print-certs $apk 2>$null | Select-String 'certificate (DN|SHA-256)'
    & $signer verify $apk 2>$null | Out-Null
    $verifyExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($verifyExit -ne 0) { throw 'Signature verification FAILED' }
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
