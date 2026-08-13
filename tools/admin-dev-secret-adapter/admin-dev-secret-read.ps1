param(
    [Parameter(Mandatory)][string] $Reference,
    [ValidateRange(15, 300)][int] $ClipboardLifetimeSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Betta.Admin.DevSecret.psm1') -Force

$grant = $null
try {
    $metadata = Get-BettaDevSecretMetadata -Reference $Reference
    $grant = Read-BettaDevSecret -Reference $Reference
    Set-Clipboard -Value $grant
    Write-Host "Admin public ID: $($metadata.targetPublicId)"
    Write-Host "Grant expires at (UTC): $($metadata.expiresAt)"
    Write-Host "Activation grant copied to clipboard for at most $ClipboardLifetimeSeconds seconds."
    Write-Host 'Paste it only into the local Admin activation form.'
    Start-Sleep -Seconds $ClipboardLifetimeSeconds

    $currentClipboard = Get-Clipboard -Raw -ErrorAction SilentlyContinue
    if ($currentClipboard -ceq $grant) {
        Set-Clipboard -Value ''
    }
    Write-Host 'Clipboard cleanup completed.'
}
catch {
    Write-Error 'Cannot read the DPAPI development secret.'
    exit 1
}
finally {
    $grant = $null
}
