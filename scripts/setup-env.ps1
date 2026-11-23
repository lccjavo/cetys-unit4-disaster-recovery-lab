# PowerShell equivalent of scripts/setup-env.sh (Windows without WSL2).
# Generates .env from .env.example with random local secrets.
# Never overwrites an existing .env without confirmation.
#
# Usage (from the repository root):
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup-env.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup-env.ps1 -Force

param([switch]$Force)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path '.env.example')) { throw ".env.example not found in $root" }

if (Test-Path '.env') {
  if (-not $Force) {
    Write-Warning 'A .env file already exists. If you regenerate it, the new passwords will not match existing volumes.'
    $answer = Read-Host 'Type OVERWRITE to replace it (a copy will be saved)'
    if ($answer -ne 'OVERWRITE') { Write-Host 'Keeping the current .env. Nothing was changed.'; exit 0 }
  }
  $backup = ".env.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item '.env' $backup
  Write-Host "Copy of the previous .env: $backup"
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
# UTF-8 without BOM and LF line endings, as Docker Compose expects.
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $root '.env'), (($lines -join "`n") + "`n"), $utf8)

if (Select-String -Path '.env' -Pattern '^[A-Z_]+=CHANGE_ME$' -Quiet) { throw 'CHANGE_ME values remain in .env' }

$cfg = @{}
Get-Content '.env' | Where-Object { $_ -match '^[A-Z_]+=.' } | ForEach-Object { $k, $v = $_ -split '=', 2; $cfg[$k] = $v }

Write-Host ""
Write-Host "File .env generated successfully ($generated random secrets)"
Write-Host "  Database              : $($cfg.POSTGRES_DB)"
Write-Host "  Host inside Docker    : $($cfg.DB_HOST):$($cfg.DB_PORT)"
Write-Host "  Host for DBeaver      : 127.0.0.1:$($cfg.POSTGRES_HOST_PORT)"
Write-Host "  Read-only user        : $($cfg.DB_READER_USER) (password in DB_READER_PASSWORD)"
Write-Host "  Hotel Management      : http://localhost:$($cfg.HOTEL_APP_PORT)"
Write-Host "  Key Vault (GUI)       : http://localhost:$($cfg.KEY_VAULT_APP_PORT)"
Write-Host ""
Write-Host "Passwords are not printed. Look them up with:  notepad .env"
Write-Host "Next step: docker compose up -d postgres-primary key-vault"
Write-Host "Note: the other scripts (*.sh) require Git Bash or WSL2."
