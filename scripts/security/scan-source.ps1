[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Get-Location).Path,
    [Parameter(Mandatory = $true)]
    [string]$SensitivePatternsFile
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$patterns = Get-Content -LiteralPath $SensitivePatternsFile |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and -not $_.StartsWith('#') }

$files = @(& git -C $root ls-files --cached --others --exclude-standard)
if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate candidate files.' }

$findings = [System.Collections.Generic.List[string]]::new()
$deniedPath = '(^|[\\/])(\.git|node_modules|vendor|dist|build|coverage|artifacts|uploads|storage|logs|tmp|temp|backups)([\\/]|$)|(^|[\\/])\.env($|\.)|\.(pem|key|pfx|p12|crt|cer|dump|backup|bak)$'
$secretPatterns = @(
    '-----BEGIN [A-Z ]+PRIVATE KEY-----',
    '\bAKIA[0-9A-Z]{16}\b',
    '\bgh[pousr]_[A-Za-z0-9]{20,}\b',
    '\bgithub_pat_[A-Za-z0-9_]{20,}\b',
    'Authorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}',
    '(?i)(password|secret|token|api[_-]?key)\s*[:=]\s*["''][^"'']{16,}["'']'
)

foreach ($relative in $files) {
    $normal = $relative.Replace('\', '/')
    if ($normal -match $deniedPath) {
        $findings.Add("DENIED_PATH $normal")
        continue
    }

    $path = Join-Path $root $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
    try { $text = [System.IO.File]::ReadAllText($path) } catch { continue }

    foreach ($pattern in $patterns) {
        if ($normal.IndexOf($pattern, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $text.IndexOf($pattern, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $findings.Add("SENSITIVE_PATTERN $normal")
        }
    }
    foreach ($pattern in $secretPatterns) {
        if ($text -match $pattern) { $findings.Add("SECRET_PATTERN $normal") }
    }

    foreach ($match in [regex]::Matches($text, '\b(?:\d{1,3}\.){3}\d{1,3}\b')) {
        if ($match.Value -notin @('127.0.0.1', '0.0.0.0')) { $findings.Add("IP_ADDRESS $normal") }
    }
    foreach ($match in [regex]::Matches($text, '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')) {
        if (-not $match.Value.EndsWith('.invalid', [System.StringComparison]::OrdinalIgnoreCase)) {
            $findings.Add("EMAIL_ADDRESS $normal")
        }
    }
}

$unique = @($findings | Sort-Object -Unique)
if ($unique.Count) {
    $unique | ForEach-Object { Write-Error $_ }
    Write-Output "SOURCE_SCAN_FAIL files=$($files.Count) findings=$($unique.Count)"
    exit 1
}

Write-Output "SOURCE_SCAN_PASS files=$($files.Count) findings=0"
