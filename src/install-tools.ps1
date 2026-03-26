param(
  [Parameter(Mandatory = $true)]
  [string]$ComputerName,

  [Parameter(Mandatory = $true)]
  [string]$Username,

  [Parameter(Mandatory = $true)]
  [string]$Password,

  [Parameter(Mandatory = $true)]
  [string]$ToolPathsJson,

  [string]$DestinationRoot = "C:\Tools",

  [int]$Port,

  [switch]$UseSsl,

  [switch]$SkipCertificateCheck
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ToolPaths = [string[]](ConvertFrom-Json -InputObject $ToolPathsJson)

$securePassword = ConvertTo-SecureString $Password -AsPlainText -Force
$credential = New-Object System.Management.Automation.PSCredential ($Username, $securePassword)

$sessionArguments = @{
  ComputerName = $ComputerName
  Credential = $credential
  ErrorAction = "Stop"
}

if ($PSBoundParameters.ContainsKey("Port")) {
  $sessionArguments.Port = $Port
}

if ($UseSsl) {
  $sessionArguments.UseSSL = $true

  if ($SkipCertificateCheck) {
    $sessionArguments.SessionOption = New-PSSessionOption -SkipCACheck -SkipCNCheck -SkipRevocationCheck
  }
}

$session = New-PSSession @sessionArguments

try {
  Invoke-Command -Session $session -ArgumentList $DestinationRoot -ScriptBlock {
    param($RemoteDestinationRoot)

    if (-not (Test-Path -Path $RemoteDestinationRoot)) {
      New-Item -Path $RemoteDestinationRoot -ItemType Directory -Force | Out-Null
    }
  }

  foreach ($toolPath in $ToolPaths) {
    if (-not (Test-Path -Path $toolPath)) {
      throw "Tool file not found: $toolPath"
    }

    $toolName = Split-Path -Path $toolPath -Leaf
    $remoteArchivePath = Join-Path -Path $DestinationRoot -ChildPath $toolName

    Write-Host "Copying $toolName to $ComputerName..."
    Copy-Item -Path $toolPath -Destination $remoteArchivePath -ToSession $session -Force

    if ([System.IO.Path]::GetExtension($toolName).Equals(".zip", [System.StringComparison]::OrdinalIgnoreCase)) {
      $extractDirectory = Join-Path -Path $DestinationRoot -ChildPath ([System.IO.Path]::GetFileNameWithoutExtension($toolName))

      Invoke-Command -Session $session -ArgumentList $remoteArchivePath, $extractDirectory -ScriptBlock {
        param($ArchivePath, $ExtractDirectory)

        if (Test-Path -Path $ExtractDirectory) {
          Remove-Item -Path $ExtractDirectory -Recurse -Force
        }

        Expand-Archive -Path $ArchivePath -DestinationPath $ExtractDirectory -Force
      }

      Write-Host "Extracted $toolName to $extractDirectory"
      continue
    }

    Write-Host "Copied $toolName to $remoteArchivePath"
  }

  Write-Host "Tool installation complete."
}
finally {
  if ($null -ne $session) {
    Remove-PSSession -Session $session
  }
}