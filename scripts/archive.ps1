param(
  [Parameter(Mandatory=$true)][ValidateSet('Extract','Create')][string]$Action,
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
if ($Action -eq 'Extract') {
  [System.IO.Compression.ZipFile]::ExtractToDirectory($Source, $Destination)
} else {
  [System.IO.Compression.ZipFile]::CreateFromDirectory($Source, $Destination, [System.IO.Compression.CompressionLevel]::Optimal, $true)
}
