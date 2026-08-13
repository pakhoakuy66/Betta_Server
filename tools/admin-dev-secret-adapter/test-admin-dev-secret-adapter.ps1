Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$writer = Join-Path $PSScriptRoot 'admin-dev-secret-writer.ps1'
$module = Join-Path $PSScriptRoot 'Betta.Admin.DevSecret.psm1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('betta-dpapi-test-' + [Guid]::NewGuid().ToString('N'))
$oldNodeEnv = $env:NODE_ENV
$oldStoreRoot = $env:BETTA_DEV_SECRET_STORE_ROOT
$grant = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

try {
    $env:NODE_ENV = 'development'
    $env:BETTA_DEV_SECRET_STORE_ROOT = $testRoot
    Import-Module $module -Force

    $command = [ordered]@{
        operation  = 'put-version'
        secretName = 'betta/admin/bootstrap-super-admin'
        value      = $grant
        expiresAt  = [DateTimeOffset]::UtcNow.AddMinutes(15).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        metadata   = [ordered]@{
            purpose       = 'bootstrap_super_admin'
            targetPublicId = 'adm_23456789ABCD'
            environment   = 'developer'
        }
    } | ConvertTo-Json -Compress

    $output = $command | & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $writer
    if ($LASTEXITCODE -ne 0) { throw 'Writer put-version failed.' }
    if (($output -join "`n").Contains($grant)) { throw 'Writer leaked the raw grant.' }

    $reference = [string](($output -join "`n") | ConvertFrom-Json).reference
    $files = @(Get-ChildItem -LiteralPath $testRoot -Filter '*.json')
    if ($files.Count -ne 1) { throw 'Expected exactly one encrypted envelope.' }
    if ((Get-Content -Raw -LiteralPath $files[0].FullName).Contains($grant)) {
        throw 'Encrypted envelope contains the raw grant.'
    }
    if ((Read-BettaDevSecret -Reference $reference) -cne $grant) {
        throw 'DPAPI round-trip failed.'
    }

    $revoke = @{ operation = 'revoke-version'; reference = $reference } | ConvertTo-Json -Compress
    $null = $revoke | & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $writer
    if ($LASTEXITCODE -ne 0) { throw 'Writer revoke-version failed.' }
    if (Test-Path -LiteralPath $files[0].FullName) { throw 'Revoked envelope still exists.' }

    $adminActivationCommand = [ordered]@{
        operation  = 'put-version'
        secretName = 'betta/admin/account-activation/adm_23456789ABCD'
        value      = $grant
        expiresAt  = [DateTimeOffset]::UtcNow.AddMinutes(15).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        metadata   = [ordered]@{
            purpose        = 'admin_account_activation'
            targetPublicId = 'adm_23456789ABCD'
            environment    = 'developer'
        }
    } | ConvertTo-Json -Compress

    $adminOutput = $adminActivationCommand | & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $writer
    if ($LASTEXITCODE -ne 0) { throw 'Admin activation put-version failed.' }
    if (($adminOutput -join "`n").Contains($grant)) { throw 'Admin activation writer leaked the raw grant.' }

    $adminReference = [string](($adminOutput -join "`n") | ConvertFrom-Json).reference
    if ((Read-BettaDevSecret -Reference $adminReference) -cne $grant) {
        throw 'Admin activation DPAPI round-trip failed.'
    }
    Remove-BettaDevSecret -Reference $adminReference

    $env:NODE_ENV = 'production'
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $productionOutput = $command | & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $writer 2>&1
    $productionExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    if ($productionExitCode -eq 0) { throw 'Production execution was not rejected.' }
    if (($productionOutput -join "`n").Contains($grant)) { throw 'Production rejection leaked the raw grant.' }

    Write-Host 'PASS: DPAPI development adapter supports bootstrap/admin activation, revokes and fails closed in production.'
}
finally {
    if ($null -eq $oldNodeEnv) { Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue }
    else { $env:NODE_ENV = $oldNodeEnv }
    if ($null -eq $oldStoreRoot) { Remove-Item Env:BETTA_DEV_SECRET_STORE_ROOT -ErrorAction SilentlyContinue }
    else { $env:BETTA_DEV_SECRET_STORE_ROOT = $oldStoreRoot }
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
    $grant = $null
}
