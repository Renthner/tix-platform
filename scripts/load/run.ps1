<#
.SYNOPSIS
  Load test of the ticketing platform in an isolated Docker Compose project ("tixload").
  See docs/LOAD-TEST.md.

.EXAMPLE
  .\scripts\load\run.ps1 -Vus 200
  .\scripts\load\run.ps1 -Vus 1200 -Scenarios seat-rush,checkout-rush -Keep
  .\scripts\load\run.ps1 -Target https://staging.example.org -EventId <uuid> `
      -DatabaseUrl postgres://... -RedisUrl redis://... -ConfirmNonProduction
#>
[CmdletBinding()]
param(
  [int]$Vus = 1200,
  [string[]]$Scenarios,
  [switch]$Keep,
  [switch]$NoBuild,
  [string]$ImageRegistry,
  [int]$HttpPort = 18080,
  [int]$QueueSeconds,
  [int]$Observers = 200,
  [string]$Target,
  [string]$EventId,
  [string]$DatabaseUrl,
  [string]$RedisUrl,
  [switch]$ConfirmNonProduction
)
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$a = @('scripts/load/run.mjs', '--vus', $Vus, '--http-port', $HttpPort, '--observers', $Observers)
if ($Scenarios) { $a += @('--scenarios', ($Scenarios -join ',')) }
if ($Keep) { $a += '--keep' }
if ($NoBuild) { $a += '--no-build' }
if ($ImageRegistry) { $a += @('--image-registry', $ImageRegistry) }
if ($QueueSeconds) { $a += @('--queue-seconds', $QueueSeconds) }
if ($Target) { $a += @('--target', $Target) }
if ($EventId) { $a += @('--event-id', $EventId) }
if ($DatabaseUrl) { $a += @('--database-url', $DatabaseUrl) }
if ($RedisUrl) { $a += @('--redis-url', $RedisUrl) }
if ($ConfirmNonProduction) { $a += '--confirm-non-production' }
Push-Location $repo
try {
  & node @a
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
