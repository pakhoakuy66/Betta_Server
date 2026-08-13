Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'Betta.Admin.DevSecret.psm1') -Force

try {
    Assert-BettaDevelopmentEnvironment
    $rawInput = [Console]::In.ReadToEnd()
    if ([Text.Encoding]::UTF8.GetByteCount($rawInput) -gt 32768) {
        throw 'Input is too large.'
    }

    $command = $rawInput | ConvertFrom-Json
    if ($command.operation -ceq 'put-version') {
        $reference = Write-BettaDevSecret -Command $command
        [Console]::Out.Write((@{ reference = $reference } | ConvertTo-Json -Compress))
    }
    elseif ($command.operation -ceq 'revoke-version') {
        $propertyNames = @($command.PSObject.Properties.Name)
        if ($propertyNames.Count -ne 2 -or
            $propertyNames -notcontains 'operation' -or
            $propertyNames -notcontains 'reference' -or
            $command.reference -isnot [string]) {
            throw 'Invalid revoke-version command.'
        }
        Remove-BettaDevSecret -Reference ([string]$command.reference)
        [Console]::Out.Write('{}')
    }
    else {
        throw 'Unsupported operation.'
    }
}
catch {
    [Console]::Error.WriteLine('DPAPI development secret operation failed.')
    exit 1
}
