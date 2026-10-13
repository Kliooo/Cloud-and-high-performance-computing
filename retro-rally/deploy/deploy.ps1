# deploy.ps1 - upload the project to a Linux VM and restart the service.
# Provider-agnostic: any VPS reachable over SSH will do.
#
# Example:
#   .\deploy.ps1 -Server 203.0.113.10
#   .\deploy.ps1 -Server 203.0.113.10 -User retro -RemoteDir /opt/retro-rally
#
# What it does:
#   1) packs the code (without src/data/ - server-side data is left untouched);
#   2) copies the archive over scp into a temp directory;
#   3) unpacks over the project and restarts the retro-rally systemd service.

param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$User = 'ubuntu',
  [string]$RemoteDir = '/opt/retro-rally',
  [string]$KeyPath = "$HOME\.ssh\id_ed25519",
  [string]$ServiceName = 'retro-rally'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$archive = Join-Path $env:TEMP "retro-rally-deploy-$(Get-Date -Format 'yyyyMMdd-HHmmss').tar.gz"
$remoteArchive = "/tmp/$(Split-Path $archive -Leaf)"

Write-Host "1/3 Packing the project from $root"
$items = @('src', 'tools', 'deploy', 'package.json', 'README.md')
$existing = $items | Where-Object { Test-Path (Join-Path $root $_) }
Push-Location $root
try {
  tar -czf $archive @existing
  if ($LASTEXITCODE -ne 0) { throw "tar exited with code $LASTEXITCODE" }
} finally {
  Pop-Location
}
$sizeKb = [math]::Round((Get-Item $archive).Length / 1KB)
Write-Host "    archive: $archive ($sizeKb KB)"

Write-Host "2/3 Copying to $User@${Server}:$remoteArchive"
scp -i $KeyPath $archive "${User}@${Server}:$remoteArchive"

Write-Host "3/3 Unpacking and restarting the $ServiceName service"
$remote = @"
set -e
sudo mkdir -p $RemoteDir
sudo tar -xzf $remoteArchive -C $RemoteDir
sudo chown -R `$(id -un):`$(id -gn) $RemoteDir
rm -f $remoteArchive
sudo systemctl restart $ServiceName
sleep 1
systemctl --no-pager --lines=5 status $ServiceName || true
curl -s http://127.0.0.1:8080/api/health || echo 'health did not answer — check journalctl -u $ServiceName'
"@
ssh -i $KeyPath "${User}@${Server}" $remote

Remove-Item $archive -Force -ErrorAction SilentlyContinue
Write-Host 'Done.'
