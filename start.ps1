# Запуск cordis + HTTPS (Caddy) на нестандартном порту.
#   .\start.ps1 -Domain myname.duckdns.org -Token <duckdns-token> [-Port 8443]
# Параметры запоминаются в local-config.json, дальше достаточно .\start.ps1
param([string]$Domain, [string]$Token, [int]$Port)

$cfgFile = Join-Path $PSScriptRoot 'local-config.json'
$cfg = if (Test-Path $cfgFile) { Get-Content $cfgFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
if ($Domain) { $cfg | Add-Member -Force Domain $Domain }
if ($Token)  { $cfg | Add-Member -Force Token $Token }
if ($Port)   { $cfg | Add-Member -Force Port $Port }
if (-not $cfg.Port) { $cfg | Add-Member -Force Port 8443 }
if (-not $cfg.Domain -or -not $cfg.Token) {
  Write-Host 'Нужны -Domain и -Token (см. README).' -ForegroundColor Red
  exit 1
}
$cfg | ConvertTo-Json | Set-Content $cfgFile -Encoding utf8

$env:DOMAIN = $cfg.Domain
$env:HTTPS_PORT = $cfg.Port
$env:DUCKDNS_TOKEN = $cfg.Token
Write-Host "Адрес для друзей: https://$($cfg.Domain):$($cfg.Port)" -ForegroundColor Green

$node = Start-Process node -ArgumentList 'server.js' -WorkingDirectory $PSScriptRoot -NoNewWindow -PassThru
try {
  caddy run --config (Join-Path $PSScriptRoot 'Caddyfile') --adapter caddyfile
} finally {
  Stop-Process -Id $node.Id -ErrorAction SilentlyContinue
}
