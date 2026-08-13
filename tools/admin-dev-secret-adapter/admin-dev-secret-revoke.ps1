param([Parameter(Mandatory)][string] $Reference)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Betta.Admin.DevSecret.psm1') -Force

try {
    Remove-BettaDevSecret -Reference $Reference
    Write-Host 'DPAPI development secret revoked.'
}
catch {
    Write-Error 'Cannot revoke the DPAPI development secret.'
    exit 1
}
