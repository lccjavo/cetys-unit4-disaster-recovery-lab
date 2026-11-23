# Equivalente en PowerShell de scripts/setup-env.sh (Windows sin WSL2).
# Genera .env a partir de .env.example con secretos locales aleatorios.
# Nunca sobrescribe un .env existente sin confirmacion.
#
# Uso (desde la raiz del repositorio):
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup-env.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup-env.ps1 -Force

param([switch]$Force)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path '.env.example')) { throw "No se encontro .env.example en $root" }

if (Test-Path '.env') {
  if (-not $Force) {
    Write-Warning 'Ya existe un archivo .env. Si lo regenera, las contrasenas nuevas no coincidiran con volumenes ya creados.'
    $answer = Read-Host 'Escriba SOBRESCRIBIR para reemplazarlo (se guardara una copia)'
    if ($answer -ne 'SOBRESCRIBIR') { Write-Host 'Se conserva el .env actual. No se hizo ningun cambio.'; exit 0 }
  }
  $backup = ".env.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item '.env' $backup
  Write-Host "Copia del .env anterior: $backup"
}

function New-LabSecret {
  $bytes = New-Object byte[] 16
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  'lab_' + (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

$generated = 0
$lines = Get-Content '.env.example' -Encoding UTF8 | ForEach-Object {
  if ($_ -match '^([A-Z_][A-Z0-9_]*)=CHANGE_ME$') { $generated++; "$($Matches[1])=$(New-LabSecret)" } else { $_ }
}
# UTF-8 sin BOM y saltos de linea LF, como espera Docker Compose.
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $root '.env'), (($lines -join "`n") + "`n"), $utf8)

if (Select-String -Path '.env' -Pattern 'CHANGE_ME' -Quiet) { throw 'Quedaron valores CHANGE_ME en .env' }

$cfg = @{}
Get-Content '.env' | Where-Object { $_ -match '^[A-Z_]+=.' } | ForEach-Object { $k, $v = $_ -split '=', 2; $cfg[$k] = $v }

Write-Host ""
Write-Host "Archivo .env generado correctamente ($generated secretos aleatorios)"
Write-Host "  Base de datos         : $($cfg.POSTGRES_DB)"
Write-Host "  Host dentro de Docker : $($cfg.DB_HOST):$($cfg.DB_PORT)"
Write-Host "  Host para DBeaver     : 127.0.0.1:$($cfg.POSTGRES_HOST_PORT)"
Write-Host "  Usuario solo lectura  : $($cfg.DB_READER_USER) (contrasena en DB_READER_PASSWORD)"
Write-Host "  Hotel Management      : http://localhost:$($cfg.HOTEL_APP_PORT)"
Write-Host "  Key Vault (GUI)       : http://localhost:$($cfg.KEY_VAULT_APP_PORT)"
Write-Host ""
Write-Host "Las contrasenas no se imprimen. Consultelas con:  notepad .env"
Write-Host "Siguiente paso: docker compose up -d postgres-primary key-vault"
Write-Host "Nota: los demas scripts (*.sh) requieren Git Bash o WSL2."
