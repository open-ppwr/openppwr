[CmdletBinding()]
param(
    [string]$Image = "ghcr.io/open-ppwr/openppwr:$((Get-Content package.json -Raw | ConvertFrom-Json).version)",
    [string]$OutputDirectory = '',
    [switch]$UseWsl
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $OutputDirectory) {
    $runStamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')
    $OutputDirectory = "artifacts/supply-chain/run-$runStamp-$PID"
}
if (Test-Path -LiteralPath $OutputDirectory) {
    if (@(Get-ChildItem -LiteralPath $OutputDirectory -Force).Count -gt 0) { throw 'Supply-chain output directory must be new or empty.' }
} else {
    New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
}

node scripts/release/validate-release-ref.mjs $Image
if ($LASTEXITCODE -ne 0) { throw 'Release image reference validation failed.' }

if ($UseWsl) {
    $repositoryRoot = (Resolve-Path '.').Path
    $wslOutputDirectory = $OutputDirectory.Replace('\', '/')
    wsl.exe --cd $repositoryRoot --exec sh scripts/release/run-wsl-supply-chain-gate.sh $Image $wslOutputDirectory
    if ($LASTEXITCODE -ne 0) { throw 'WSL supply-chain gate failed.' }
    exit 0
}

$toolPaths = [ordered]@{}
$missingTools = @()
foreach ($tool in @('docker', 'grype', 'syft', 'trivy', 'cosign')) {
    $command = Get-Command $tool -ErrorAction SilentlyContinue
    if ($command) {
        $toolPaths[$tool] = $command.Source
    } else {
        $missingTools += $tool
    }
}
if ($missingTools.Count -gt 0) {
    throw "Required tools missing: $($missingTools -join ', ')"
}

docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker engine is unavailable.' }

$startedAt = (Get-Date).ToUniversalTime().ToString('o')
$sourceRevision = (git rev-parse HEAD).Trim()

$productVersion = (Get-Content package.json -Raw | ConvertFrom-Json).version
# Build metadata the deployment reports at /v1/version. Omitting these left builtAt and
# migrationLevel reading "unknown" on a freshly built image.
$buildTimestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$migrationLevel = (Get-ChildItem packages/database/migrations/*.sql | ForEach-Object { ($_.Name -split "_")[0] } | Sort-Object | Select-Object -Last 1)
$releaseChannel = if ($env:OPENPPWR_RELEASE_CHANNEL) { $env:OPENPPWR_RELEASE_CHANNEL } else { "private-rc" }
docker build --pull --build-arg "OPENPPWR_VERSION=$productVersion" --build-arg "OPENPPWR_REVISION=$sourceRevision" --build-arg "OPENPPWR_BUILD_TIMESTAMP=$buildTimestamp" --build-arg "OPENPPWR_RELEASE_CHANNEL=$releaseChannel" --build-arg "OPENPPWR_MIGRATION_LEVEL=$migrationLevel" --tag $Image .
if ($LASTEXITCODE -ne 0) { throw 'Container build failed.' }

$imageId = docker image inspect --format '{{.Id}}' $Image
if ($LASTEXITCODE -ne 0 -or -not $imageId) { throw 'Built image inspection failed.' }

$grypeReport = Join-Path $OutputDirectory 'grype-image.json'
grype $Image --fail-on high --output json --file $grypeReport
if ($LASTEXITCODE -ne 0) { throw 'Grype found HIGH/CRITICAL vulnerabilities or failed.' }

$trivyReport = Join-Path $OutputDirectory 'trivy-config.json'
trivy config --scanners misconfig --severity HIGH,CRITICAL --exit-code 1 --format json --output $trivyReport .
if ($LASTEXITCODE -ne 0) { throw 'Trivy found HIGH/CRITICAL configuration findings or failed.' }

$spdxReport = Join-Path $OutputDirectory "openppwr-$productVersion.spdx.json"
$cycloneDxReport = Join-Path $OutputDirectory "openppwr-$productVersion.cyclonedx.json"
syft $Image --output "spdx-json=$spdxReport"
if ($LASTEXITCODE -ne 0) { throw 'SPDX SBOM generation failed.' }
syft $Image --output "cyclonedx-json=$cycloneDxReport"
if ($LASTEXITCODE -ne 0) { throw 'CycloneDX SBOM generation failed.' }

$versions = [ordered]@{}
foreach ($tool in $toolPaths.Keys) {
    $versions[$tool] = (& $tool version 2>&1 | Out-String).Trim()
}

$files = @($grypeReport, $trivyReport, $spdxReport, $cycloneDxReport)
$evidence = [ordered]@{
    status = 'PASS'
    startedAt = $startedAt
    finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    sourceRevision = $sourceRevision
    image = $Image
    imageId = $imageId.Trim()
    published = $false
    signing = 'NOT_RUN_LOCAL_PUBLICATION_FORBIDDEN'
    tools = $versions
    artifacts = @($files | ForEach-Object {
        $item = Get-Item $_
        [ordered]@{ path = $item.FullName; bytes = $item.Length; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_).Hash.ToLowerInvariant() }
    })
}
$evidence | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $OutputDirectory 'supply-chain-evidence.json')
Write-Output "SUPPLY_CHAIN_GATE_PASS image=$Image imageId=$imageId published=false output=$OutputDirectory"
