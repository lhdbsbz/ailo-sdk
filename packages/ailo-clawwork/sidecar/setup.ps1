<#
.SYNOPSIS
  One-time setup for ClawWork sidecar: download GDPVal dataset, create Python venv, install deps.
.DESCRIPTION
  Run from the sidecar/ directory:
    .\setup.ps1
#>

$ErrorActionPreference = "Stop"

$SIDECAR_DIR = $PSScriptRoot
$PACKAGE_DIR = Resolve-Path (Join-Path $SIDECAR_DIR "..")
$WORKSPACE   = Resolve-Path (Join-Path $SIDECAR_DIR "../../../../")
$CLAWWORK    = Join-Path $WORKSPACE "ClawWork"
$GDPVAL_DIR  = Join-Path $CLAWWORK "gdpval"

Write-Host ""
Write-Host "=== ClawWork Sidecar Setup ===" -ForegroundColor Cyan
Write-Host "  Workspace : $WORKSPACE"
Write-Host "  ClawWork  : $CLAWWORK"
Write-Host "  Sidecar   : $SIDECAR_DIR"
Write-Host ""

# ── 1. Check ClawWork repo exists ──
if (-not (Test-Path (Join-Path $CLAWWORK "README.md"))) {
    Write-Host "[ERROR] ClawWork repo not found at: $CLAWWORK" -ForegroundColor Red
    Write-Host "  Please clone it first: git clone https://github.com/HKUDS/ClawWork.git `"$CLAWWORK`""
    exit 1
}
Write-Host "[OK] ClawWork repo found" -ForegroundColor Green

# ── 2. Download GDPVal dataset ──
if (Test-Path (Join-Path $GDPVAL_DIR "data")) {
    Write-Host "[OK] GDPVal dataset already exists at: $GDPVAL_DIR" -ForegroundColor Green
} else {
    Write-Host "[..] Downloading GDPVal dataset from HuggingFace (1.6 GB)..." -ForegroundColor Yellow
    Write-Host "     git clone https://huggingface.co/datasets/openai/gdpval $GDPVAL_DIR"

    $hasLfs = $null
    try { $hasLfs = git lfs version 2>$null } catch {}

    if (-not $hasLfs) {
        Write-Host "[WARN] git-lfs not installed. Installing..." -ForegroundColor Yellow
        git lfs install
    }

    git clone https://huggingface.co/datasets/openai/gdpval $GDPVAL_DIR
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Failed to clone GDPVal dataset." -ForegroundColor Red
        Write-Host "  You can manually download from: https://huggingface.co/datasets/openai/gdpval"
        Write-Host "  Place it at: $GDPVAL_DIR"
        exit 1
    }
    Write-Host "[OK] GDPVal dataset downloaded" -ForegroundColor Green
}

# ── 3. Verify key files ──
$parquet = Join-Path $GDPVAL_DIR "data/train-00000-of-00001.parquet"
if (-not (Test-Path $parquet)) {
    Write-Host "[ERROR] Parquet file not found: $parquet" -ForegroundColor Red
    Write-Host "  The GDPVal dataset may not have downloaded correctly (git-lfs needed for large files)."
    Write-Host "  Try: cd $GDPVAL_DIR; git lfs pull"
    exit 1
}
Write-Host "[OK] GDPVal parquet file found" -ForegroundColor Green

$metaPrompts = Join-Path $CLAWWORK "eval/meta_prompts"
$metaCount = (Get-ChildItem -Path $metaPrompts -Filter "*.json" -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Host "[OK] Found $metaCount evaluation meta-prompts" -ForegroundColor Green

# ── 4. Poppler (PDF to image conversion) ──
$popplerBin = Get-ChildItem -Path "C:\tools\poppler" -Recurse -Filter "pdftoppm.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($popplerBin) {
    Write-Host "[OK] Poppler already installed at: $($popplerBin.DirectoryName)" -ForegroundColor Green
} else {
    Write-Host "[..] Downloading Poppler for Windows..." -ForegroundColor Yellow
    $popplerDir = "C:\tools\poppler"
    New-Item -ItemType Directory -Force -Path $popplerDir | Out-Null
    $popplerUrl = "https://github.com/oschwartz10612/poppler-windows/releases/download/v24.08.0-0/Release-24.08.0-0.zip"
    $popplerZip = "$env:TEMP\poppler-win.zip"
    Invoke-WebRequest -Uri $popplerUrl -OutFile $popplerZip -UseBasicParsing
    Expand-Archive -Path $popplerZip -DestinationPath $popplerDir -Force
    Remove-Item $popplerZip -Force
    $popplerBin = Get-ChildItem -Path $popplerDir -Recurse -Filter "pdftoppm.exe" | Select-Object -First 1
    if ($popplerBin) {
        Write-Host "[OK] Poppler installed" -ForegroundColor Green
    } else {
        Write-Host "[WARN] Poppler extraction failed. Download manually from: https://github.com/oschwartz10612/poppler-windows/releases" -ForegroundColor Yellow
    }
}
if ($popplerBin) {
    $binPath = $popplerBin.DirectoryName
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$binPath*") {
        [Environment]::SetEnvironmentVariable("Path", "$userPath;$binPath", "User")
        $env:Path = "$env:Path;$binPath"
        Write-Host "     Added Poppler to PATH" -ForegroundColor Green
    }
}

# ── 5. Python venv ──
$VENV = Join-Path $SIDECAR_DIR ".venv"
if (Test-Path (Join-Path $VENV "Scripts/python.exe")) {
    Write-Host "[OK] Python venv already exists" -ForegroundColor Green
} else {
    Write-Host "[..] Creating Python virtual environment..." -ForegroundColor Yellow
    python -m venv $VENV
    Write-Host "[OK] Venv created at: $VENV" -ForegroundColor Green
}

# ── 6. Install dependencies ──
Write-Host "[..] Installing Python dependencies..." -ForegroundColor Yellow
$pip = Join-Path $VENV "Scripts/pip.exe"
& $pip install -r (Join-Path $SIDECAR_DIR "requirements.txt") -q
& $pip install -r (Join-Path $CLAWWORK "requirements.txt") -q
# ClawWork's requirements.txt doesn't list all transitive deps pulled by its __init__.py import chain
& $pip install PyPDF2 e2b-code-interpreter langchain-core -q
Write-Host "[OK] Dependencies installed" -ForegroundColor Green

# ── 7. .env file ──
$envFile = Join-Path $SIDECAR_DIR ".env"
if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $SIDECAR_DIR ".env.example") $envFile
    Write-Host "[OK] Created .env from .env.example (edit it to add your API key)" -ForegroundColor Yellow
} else {
    Write-Host "[OK] .env already exists" -ForegroundColor Green
}

# ── Done ──
Write-Host ""
Write-Host "=== Setup Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  1. Edit sidecar/.env and set EVALUATION_API_KEY (OpenAI/OpenRouter key)"
Write-Host "  2. Start the sidecar:  .venv/Scripts/python server.py"
Write-Host "  3. Start the endpoint: cd .. && npm install && npm run dev"
Write-Host ""
