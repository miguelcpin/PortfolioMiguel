# Instalador do servidor Resenha para Windows.
# Uso (PowerShell):  irm <URL deste arquivo> | iex
#
# Faz tudo sozinho: instala o Node.js se faltar, baixa o Resenha para
# %USERPROFILE%\Resenha, instala as dependências, pergunta o código de convite,
# cria um atalho "Ligar Resenha" na Área de Trabalho e liga o servidor.

$ErrorActionPreference = 'Stop'
$Branch = if ($env:RESENHA_BRANCH) { $env:RESENHA_BRANCH } else { 'main' }
$Root = Join-Path $HOME 'Resenha'
$AppDir = Join-Path $Root 'app'
$DataDir = Join-Path $Root 'dados'   # fica fora de app\ para sobreviver a atualizações
$ServerDir = Join-Path $AppDir 'resenha\server'

function Passo($texto) { Write-Host "`n==> $texto" -ForegroundColor Cyan }
function Ok($texto) { Write-Host "    $texto" -ForegroundColor Green }

function Atualizar-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

Write-Host "`n  Resenha - instalador do servidor`n" -ForegroundColor Magenta

# 1. Node.js
Passo 'Verificando o Node.js'
Atualizar-Path
$node = Get-Command node -ErrorAction SilentlyContinue
$precisaNode = -not $node
if ($node) {
  $versao = (& node -v).TrimStart('v').Split('.')[0]
  if ([int]$versao -lt 18) { $precisaNode = $true; Write-Host "    Node $versao é antigo, vou atualizar." }
}
if ($precisaNode) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host '    Não achei o winget. Instale o Node.js LTS em https://nodejs.org e rode este instalador de novo.' -ForegroundColor Yellow
    return
  }
  Write-Host '    Instalando Node.js LTS (o Windows pode pedir permissão)...'
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --silent
  Atualizar-Path
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host '    Node.js instalado, mas o PowerShell ainda não o enxerga. Feche esta janela, abra outra e rode o mesmo comando de novo.' -ForegroundColor Yellow
    return
  }
}
Ok ("Node.js " + (& node -v))

# 2. Baixar o Resenha
Passo "Baixando o Resenha ($Branch)"
New-Item -ItemType Directory -Force -Path $Root, $DataDir | Out-Null
$zip = Join-Path $env:TEMP 'resenha.zip'
$tmp = Join-Path $env:TEMP 'resenha-extract'
Invoke-WebRequest "https://github.com/miguelcpin/PortfolioMiguel/archive/refs/heads/$Branch.zip" -OutFile $zip -UseBasicParsing
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Expand-Archive $zip -DestinationPath $tmp -Force
$extraido = Get-ChildItem $tmp -Directory | Select-Object -First 1
# Guarda o .env de uma instalação anterior
$envAntigo = $null
$envPath = Join-Path $ServerDir '.env'
if (Test-Path $envPath) { $envAntigo = Get-Content $envPath -Raw }
if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
Move-Item $extraido.FullName $AppDir
Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
Ok "Arquivos em $AppDir"

# 3. Dependências
Passo 'Instalando dependências (npm install)'
Push-Location $ServerDir
try { & npm.cmd install --omit=dev --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw 'npm install falhou' } } finally { Pop-Location }
Ok 'Dependências instaladas'

# 4. Configuração
Passo 'Configurando'
if ($envAntigo) {
  Set-Content -Path $envPath -Value $envAntigo -Encoding UTF8
  $convite = ([regex]::Match($envAntigo, '(?m)^INVITE_CODE=(.*)$')).Groups[1].Value.Trim()
  Ok 'Mantive a configuração anterior.'
} else {
  $sugestao = -join ((48..57) + (97..122) | Get-Random -Count 8 | ForEach-Object { [char]$_ })
  $convite = Read-Host "    Código de convite para seus amigos (Enter para usar '$sugestao')"
  if ([string]::IsNullOrWhiteSpace($convite)) { $convite = $sugestao }
  $nome = Read-Host "    Nome do servidor (Enter para 'Resenha')"
  if ([string]::IsNullOrWhiteSpace($nome)) { $nome = 'Resenha' }
  @(
    'PORT=3000'
    "INVITE_CODE=$convite"
    "SERVER_NAME=$nome"
    'MAX_USERS=10'
    'MAX_UPLOAD_MB=500'
    "DATA_DIR=$DataDir"
  ) | Set-Content -Path $envPath -Encoding UTF8
  Ok "Configuração salva em $envPath"
}

# 5. Firewall (só dá sem pedir se já estiver como administrador)
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($admin) {
  if (-not (Get-NetFirewallRule -DisplayName 'Resenha' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'Resenha' -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private | Out-Null
    Ok 'Porta 3000 liberada no Firewall (redes privadas).'
  }
}

# 6. Atalho "Ligar Resenha"
Passo 'Criando atalho na Área de Trabalho'
$bat = Join-Path $Root 'Ligar Resenha.bat'
@"
@echo off
title Resenha - servidor (feche esta janela para desligar)
cd /d "$ServerDir"
node src\index.js
pause
"@ | Set-Content -Path $bat -Encoding Default
try {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut((Join-Path $desktop 'Ligar Resenha.lnk'))
  $lnk.TargetPath = $bat
  $lnk.WorkingDirectory = $ServerDir
  $lnk.Save()
  Ok 'Atalho "Ligar Resenha" criado. Nas próximas vezes é só clicar nele.'
} catch {
  Ok "Para ligar nas próximas vezes, abra: $bat"
}

# 7. Endereços
$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Select-Object -ExpandProperty IPAddress
$tailscale = $ips | Where-Object { $_ -match '^100\.' }
$lan = $ips | Where-Object { $_ -match '^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)' }

Write-Host "`n==================================================" -ForegroundColor Magenta
Write-Host '  Tudo pronto! Ligando o servidor...' -ForegroundColor Magenta
Write-Host "==================================================`n" -ForegroundColor Magenta
Write-Host '  Neste PC:              http://localhost:3000'
foreach ($ip in $lan) { Write-Host "  Celular no mesmo Wi-Fi: http://${ip}:3000" -ForegroundColor Green }
foreach ($ip in $tailscale) { Write-Host "  Pelo Tailscale:         http://${ip}:3000" -ForegroundColor Green }
Write-Host "  Código de convite:      $convite" -ForegroundColor Yellow
Write-Host "`n  Se o Windows perguntar sobre o Firewall, marque 'Redes privadas' e clique em Permitir."
Write-Host '  Deixe esta janela aberta. Para desligar: Ctrl + C.'
Write-Host "  Seus dados (contas, mensagens, arquivos) ficam em $DataDir`n"

Set-Location $ServerDir
& node src\index.js
