param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$InstallerArtifact,
  [Parameter(Mandatory = $true)][string]$Signature,
  [string]$ServerData = "update-server/data",
  [string]$ServerHost = "DESKTOP-CALLUM"
)

$ErrorActionPreference = "Stop"
$appDir = Join-Path $ServerData "pepper"
New-Item -ItemType Directory -Force -Path $appDir | Out-Null

$assetName = Split-Path -Leaf $InstallerArtifact
Copy-Item -LiteralPath $InstallerArtifact -Destination (Join-Path $appDir $assetName) -Force

$metadata = [ordered]@{
  version = $Version
  notes = "Pepper $Version"
  pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      url = "http://${ServerHost}:8088/pepper/$assetName"
      signature = (Get-Content -Raw -LiteralPath $Signature).Trim()
    }
  }
}

$metadataJson = $metadata | ConvertTo-Json -Depth 6
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $appDir "latest.json"), $metadataJson, $utf8NoBom)
Write-Host "Published Pepper $Version to $appDir"
