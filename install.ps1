# Easy installer for CCE Cheat Checker (Vencord userplugin)
# Prefer double-clicking Install.bat (this file is launched by it).

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red }

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginSrc = Join-Path $RepoRoot "src\userplugins\cceCheatChecker"

if (-not (Test-Path (Join-Path $PluginSrc "index.tsx"))) {
    Write-Fail "Plugin source not found at:`n  $PluginSrc`nClone the full CCE-Cheat-Checker repo first."
    exit 1
}

Write-Host ""
Write-Host "  CCE Cheat Checker — easy install" -ForegroundColor White
Write-Host "  Use a dedicated Discord alt. Keep Safe mode ON." -ForegroundColor DarkGray
Write-Host ""

# --- prerequisites ---
Write-Step "Checking prerequisites"

function Test-Cmd($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

if (-not (Test-Cmd "git")) {
    Write-Fail "git is required. Install from https://git-scm.com/ and re-run."
    exit 1
}
Write-Ok "git OK"

if (-not (Test-Cmd "node")) {
    Write-Fail "Node.js is required. Install LTS from https://nodejs.org/ and re-run."
    exit 1
}
$nodeVer = (node -v)
Write-Ok "node $nodeVer"

if (-not (Test-Cmd "pnpm")) {
    Write-Warn "pnpm not found — installing via corepack..."
    try {
        corepack enable | Out-Null
        corepack prepare pnpm@latest --activate | Out-Null
    } catch {
        Write-Fail "Could not install pnpm. Run: npm install -g pnpm"
        exit 1
    }
}
Write-Ok "pnpm $((pnpm -v))"

# --- Vencord location ---
Write-Step "Vencord folder"

$defaultVencord = Join-Path $env:USERPROFILE "DEV\Vencord"
if ($env:VENCORD_DIR -and (Test-Path $env:VENCORD_DIR)) {
    $defaultVencord = $env:VENCORD_DIR
} elseif (Test-Path (Join-Path $env:USERPROFILE "Documents\Vencord")) {
    $defaultVencord = Join-Path $env:USERPROFILE "Documents\Vencord"
} elseif (Test-Path "C:\Users\$env:USERNAME\DEV\Vencord") {
    $defaultVencord = "C:\Users\$env:USERNAME\DEV\Vencord"
}

Write-Host "    Default: $defaultVencord"
$vencordInput = Read-Host "    Path to Vencord (Enter = default, or type a path)"
$VencordDir = if ([string]::IsNullOrWhiteSpace($vencordInput)) { $defaultVencord } else { $vencordInput.Trim('"') }

if (-not (Test-Path (Join-Path $VencordDir "package.json"))) {
    Write-Warn "Vencord not found at $VencordDir"
    $clone = Read-Host "    Clone Vencord there now? [Y/n]"
    if ($clone -match '^[Nn]') {
        Write-Fail "Aborted. Set VENCORD_DIR or pass an existing Vencord path."
        exit 1
    }
    $parent = Split-Path -Parent $VencordDir
    if (-not (Test-Path $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Write-Step "Cloning Vencord..."
    git clone https://github.com/Vendicated/Vencord.git $VencordDir
    Write-Ok "Cloned"
}

# --- Discord branch ---
Write-Step "Discord branch to inject"
Write-Host "    1) stable (default Discord)"
Write-Host "    2) ptb"
Write-Host "    3) canary"
$branchChoice = Read-Host "    Choose [1/2/3] (Enter = 1)"
$branch = switch ($branchChoice) {
    "2" { "ptb" }
    "3" { "canary" }
    default { "stable" }
}
Write-Ok "Branch: $branch"

# --- copy plugin ---
Write-Step "Copying plugin into Vencord"
$userPlugins = Join-Path $VencordDir "src\userplugins"
$dest = Join-Path $userPlugins "cceCheatChecker"
$legacy = Join-Path $userPlugins "apexCheatScrimOverlap"
New-Item -ItemType Directory -Path $userPlugins -Force | Out-Null
if (Test-Path $legacy) {
    Remove-Item -Recurse -Force $legacy
    Write-Warn "Removed legacy plugin folder apexCheatScrimOverlap"
}
if (Test-Path $dest) {
    Remove-Item -Recurse -Force $dest
}
Copy-Item -Recurse -Force $PluginSrc $dest
Write-Ok "Installed to $dest"

# --- build ---
Write-Step "Installing Vencord dependencies (first run can take a few minutes)"
Push-Location $VencordDir
try {
    pnpm install
    Write-Step "Building Vencord"
    pnpm build
    Write-Step "Injecting into Discord ($branch)"
    if ($branch -eq "stable") {
        pnpm inject
    } else {
        node scripts/runInstaller.mjs -- --install -branch $branch
    }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "  Done." -ForegroundColor Green
Write-Host "  1. Fully quit Discord (tray icon too), then reopen it." -ForegroundColor White
Write-Host "  2. Settings → Vencord → Plugins → enable CCECheatChecker" -ForegroundColor White
Write-Host "  3. Log in with your dedicated scanner alt (not your main)." -ForegroundColor White
Write-Host ""
Write-Host "  Reminder: matches can include CCE staff on cheat servers — verify before any ban." -ForegroundColor Yellow
Write-Host ""
