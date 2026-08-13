Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Security

$script:Entropy = [Text.Encoding]::UTF8.GetBytes('Betta.Admin.DevSecret.v1')
$script:ReferencePattern = '^dpapi://betta-dev/admin-bootstrap/(?<id>[a-f0-9]{32})$'
$script:PublicIdPattern = '^adm_[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{12}$'
$script:AllowedPurposes = @('bootstrap_super_admin', 'admin_account_activation')

function Assert-BettaDevelopmentEnvironment {
    $environment = if ($null -eq $env:NODE_ENV) { '' } else { $env:NODE_ENV.Trim().ToLowerInvariant() }
    if ($environment -eq 'production') {
        throw 'DPAPI development adapter is disabled in production.'
    }
}

function Get-BettaDevSecretStoreRoot {
    Assert-BettaDevelopmentEnvironment

    $configuredRoot = if ($null -eq $env:BETTA_DEV_SECRET_STORE_ROOT) {
        ''
    }
    else {
        $env:BETTA_DEV_SECRET_STORE_ROOT.Trim()
    }

    $root = if ($configuredRoot) {
        [IO.Path]::GetFullPath($configuredRoot)
    }
    else {
        Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Betta\dev-secrets'
    }

    if (-not [IO.Directory]::Exists($root)) {
        [IO.Directory]::CreateDirectory($root) | Out-Null
    }

    Protect-BettaDevSecretStoreAcl -Path $root
    return $root
}

function Protect-BettaDevSecretStoreAcl {
    param([Parameter(Mandatory)][string] $Path)

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($null -eq $identity.User) {
        throw 'Cannot resolve the current Windows user SID.'
    }

    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $identity.User,
        [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($rule)
    [IO.Directory]::SetAccessControl($Path, $acl)
}

function Test-BettaExactProperties {
    param(
        [Parameter(Mandatory)] $Value,
        [Parameter(Mandatory)][string[]] $Expected
    )

    if ($null -eq $Value -or $Value -isnot [psobject]) {
        return $false
    }

    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $wanted = @($Expected | Sort-Object)
    return ($actual.Count -eq $wanted.Count) -and
        (-not (Compare-Object -ReferenceObject $wanted -DifferenceObject $actual))
}

function Test-BettaCanonicalGrant {
    param([AllowNull()][object] $Value)

    if ($Value -isnot [string] -or $Value -notmatch '^[A-Za-z0-9_-]{43}$') {
        return $false
    }

    try {
        $base64 = $Value.Replace('-', '+').Replace('_', '/') + '='
        $bytes = [Convert]::FromBase64String($base64)
        $canonical = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
        return $bytes.Length -eq 32 -and $canonical -ceq $Value
    }
    catch {
        return $false
    }
}

function ConvertTo-BettaProtectedBase64 {
    param([Parameter(Mandatory)][string] $Plaintext)

    $clearBytes = [Text.Encoding]::UTF8.GetBytes($Plaintext)
    try {
        $cipherBytes = [Security.Cryptography.ProtectedData]::Protect(
            $clearBytes,
            $script:Entropy,
            [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        try {
            return [Convert]::ToBase64String($cipherBytes)
        }
        finally {
            [Array]::Clear($cipherBytes, 0, $cipherBytes.Length)
        }
    }
    finally {
        [Array]::Clear($clearBytes, 0, $clearBytes.Length)
    }
}

function ConvertFrom-BettaProtectedBase64 {
    param([Parameter(Mandatory)][string] $CipherBase64)

    $cipherBytes = [Convert]::FromBase64String($CipherBase64)
    try {
        $clearBytes = [Security.Cryptography.ProtectedData]::Unprotect(
            $cipherBytes,
            $script:Entropy,
            [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        try {
            return [Text.Encoding]::UTF8.GetString($clearBytes)
        }
        finally {
            [Array]::Clear($clearBytes, 0, $clearBytes.Length)
        }
    }
    finally {
        [Array]::Clear($cipherBytes, 0, $cipherBytes.Length)
    }
}

function Get-BettaDevSecretPath {
    param([Parameter(Mandatory)][string] $Reference)

    if ($Reference -notmatch $script:ReferencePattern) {
        throw 'Invalid DPAPI development secret reference.'
    }
    $root = Get-BettaDevSecretStoreRoot
    return Join-Path $root ($Matches.id + '.json')
}

function Remove-BettaExpiredDevSecrets {
    $root = Get-BettaDevSecretStoreRoot
    foreach ($file in [IO.Directory]::EnumerateFiles($root, '*.json', [IO.SearchOption]::TopDirectoryOnly)) {
        try {
            $envelope = [IO.File]::ReadAllText($file, [Text.Encoding]::UTF8) | ConvertFrom-Json
            $expiresAt = [DateTimeOffset]::ParseExact(
                [string]$envelope.expiresAt,
                'O',
                [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::RoundtripKind
            )
            if ($expiresAt -le [DateTimeOffset]::UtcNow) {
                [IO.File]::Delete($file)
            }
        }
        catch {
            # Malformed files are never decrypted or returned. Keep them for investigation.
        }
    }
}

function Write-BettaDevSecret {
    param([Parameter(Mandatory)] $Command)

    Assert-BettaDevelopmentEnvironment
    if (-not (Test-BettaExactProperties -Value $Command -Expected @('operation', 'secretName', 'value', 'expiresAt', 'metadata')) -or
        $Command.operation -cne 'put-version' -or
        $Command.secretName -isnot [string] -or
        $Command.secretName -notmatch '^[a-z][a-z0-9/_-]{7,127}$' -or
        -not (Test-BettaCanonicalGrant -Value $Command.value) -or
        -not (Test-BettaExactProperties -Value $Command.metadata -Expected @('purpose', 'targetPublicId', 'environment')) -or
        [string]$Command.metadata.purpose -cnotin $script:AllowedPurposes -or
        $Command.metadata.targetPublicId -isnot [string] -or
        $Command.metadata.targetPublicId -notmatch $script:PublicIdPattern -or
        $Command.metadata.environment -notin @('developer', 'test')) {
        throw 'Invalid DPAPI development put-version command.'
    }

    if ($Command.expiresAt -isnot [string] -or
        $Command.expiresAt -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$') {
        throw 'Invalid DPAPI development secret expiry format.'
    }
    $expiresAt = [DateTimeOffset]::ParseExact(
        [string]$Command.expiresAt,
        "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]'AssumeUniversal, AdjustToUniversal'
    )
    $now = [DateTimeOffset]::UtcNow
    if ($expiresAt -le $now -or $expiresAt -gt $now.AddHours(1)) {
        throw 'Invalid DPAPI development secret expiry.'
    }

    Remove-BettaExpiredDevSecrets
    $id = [Guid]::NewGuid().ToString('N')
    $reference = "dpapi://betta-dev/admin-bootstrap/$id"
    $root = Get-BettaDevSecretStoreRoot
    $path = Join-Path $root ($id + '.json')
    $temporaryPath = Join-Path $root ($id + '.' + [Guid]::NewGuid().ToString('N') + '.tmp')

    $envelope = [ordered]@{
        schemaVersion  = 1
        reference      = $reference
        secretName     = [string]$Command.secretName
        cipherBase64   = ConvertTo-BettaProtectedBase64 -Plaintext ([string]$Command.value)
        expiresAt      = $expiresAt.ToUniversalTime().ToString('O')
        purpose        = [string]$Command.metadata.purpose
        targetPublicId = [string]$Command.metadata.targetPublicId
        environment    = [string]$Command.metadata.environment
        createdAt      = [DateTimeOffset]::UtcNow.ToString('O')
    }

    try {
        $json = $envelope | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($temporaryPath, $json, [Text.UTF8Encoding]::new($false))
        [IO.File]::Move($temporaryPath, $path)
        Protect-BettaDevSecretStoreAcl -Path $root
        return $reference
    }
    finally {
        if ([IO.File]::Exists($temporaryPath)) {
            [IO.File]::Delete($temporaryPath)
        }
    }
}

function Get-BettaDevSecretEnvelope {
    param([Parameter(Mandatory)][string] $Reference)

    Assert-BettaDevelopmentEnvironment
    Remove-BettaExpiredDevSecrets
    $path = Get-BettaDevSecretPath -Reference $Reference
    if (-not [IO.File]::Exists($path)) {
        throw 'DPAPI development secret is missing, expired, or revoked.'
    }

    $envelope = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if (-not (Test-BettaExactProperties -Value $envelope -Expected @(
                'schemaVersion', 'reference', 'secretName', 'cipherBase64', 'expiresAt',
                'purpose', 'targetPublicId', 'environment', 'createdAt'
            )) -or
        [int]$envelope.schemaVersion -ne 1 -or
        [string]$envelope.reference -cne $Reference -or
        [string]$envelope.purpose -cnotin $script:AllowedPurposes -or
        [string]$envelope.environment -notin @('developer', 'test') -or
        [string]$envelope.targetPublicId -notmatch $script:PublicIdPattern) {
        throw 'DPAPI development secret envelope is invalid.'
    }

    $expiresAt = [DateTimeOffset]::ParseExact(
        [string]$envelope.expiresAt,
        'O',
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind
    )
    if ($expiresAt -le [DateTimeOffset]::UtcNow) {
        [IO.File]::Delete($path)
        throw 'DPAPI development secret is expired.'
    }

    return $envelope
}

function Get-BettaDevSecretMetadata {
    param([Parameter(Mandatory)][string] $Reference)

    $envelope = Get-BettaDevSecretEnvelope -Reference $Reference
    return [pscustomobject][ordered]@{
        reference      = [string]$envelope.reference
        targetPublicId = [string]$envelope.targetPublicId
        expiresAt      = [string]$envelope.expiresAt
    }
}

function Read-BettaDevSecret {
    param([Parameter(Mandatory)][string] $Reference)

    $envelope = Get-BettaDevSecretEnvelope -Reference $Reference

    $grant = ConvertFrom-BettaProtectedBase64 -CipherBase64 ([string]$envelope.cipherBase64)
    if (-not (Test-BettaCanonicalGrant -Value $grant)) {
        throw 'DPAPI development secret payload is invalid.'
    }
    return $grant
}

function Remove-BettaDevSecret {
    param([Parameter(Mandatory)][string] $Reference)

    Assert-BettaDevelopmentEnvironment
    $path = Get-BettaDevSecretPath -Reference $Reference
    if ([IO.File]::Exists($path)) {
        [IO.File]::Delete($path)
    }
}

Export-ModuleMember -Function @(
    'Assert-BettaDevelopmentEnvironment',
    'Get-BettaDevSecretStoreRoot',
    'Remove-BettaExpiredDevSecrets',
    'Write-BettaDevSecret',
    'Get-BettaDevSecretMetadata',
    'Read-BettaDevSecret',
    'Remove-BettaDevSecret'
)
