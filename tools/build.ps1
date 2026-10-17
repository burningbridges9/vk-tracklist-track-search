<#
.SYNOPSIS
    Builds the unpacked extension into dist\vk-tracklist-search and a ZIP.

.EXAMPLE
    pwsh -ExecutionPolicy Bypass -File tools\build.ps1
#>
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'extension'
$dist = Join-Path $root 'dist'
$target = Join-Path $dist 'vk-tracklist-search'

$manifest = Get-Content (Join-Path $source 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.version

if (Test-Path $target) {
    Remove-Item $target -Recurse -Force
}
New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item -Path (Join-Path $source '*') -Destination $target -Recurse -Force

$zip = Join-Path $dist ('vk-tracklist-search-{0}.zip' -f $version)
if (Test-Path $zip) {
    Remove-Item $zip -Force
}

# Собираем ZIP вручную, чтобы внутри были пути с «/», а не с «\».
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($zip, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    Get-ChildItem -Path $target -Recurse -File | ForEach-Object {
        $relative = $_.FullName.Substring($target.Length + 1).Replace('\', '/')
        $entryName = 'vk-tracklist-search/' + $relative
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive, $_.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
    }
}
finally {
    $archive.Dispose()
}

Write-Host ('Extension folder: {0}' -f $target)
Write-Host ('ZIP archive:      {0} ({1:N0} KB)' -f $zip, ((Get-Item $zip).Length / 1KB))
