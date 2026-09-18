# ====================================================================
#  dsh-bgm-service (DBS) - one-shot release script (GitHub + npm + Release)
#  ------------------------------------------------------------------
#  Usage (run in a normal PowerShell, with gh + npm already authenticated):
#    .\publish.ps1                    # bump patch, commit/tag, push, npm publish, gh release
#    .\publish.ps1 -Version 0.2.0     # explicit version (recommended for releases)
#    .\publish.ps1 -Version 0.2.0 -OnlyGit
#    .\publish.ps1 -Version 0.2.0 -DryRun
#
#  Steps: bump version -> clean backups -> git add/commit/tag -> push ->
#         npm publish -> gh release create + upload README.md
#
#  NOTE: keep this file ASCII-only on purpose. Windows PowerShell 5.1 reads a
#        BOM-less script as ANSI/GBK, which truncates non-ASCII strings and
#        breaks parsing ("The string is missing the terminator").
# ====================================================================
[CmdletBinding()]
param(
  [string]$Version = '',
  [switch]$OnlyGit,
  [switch]$DryRun,
  [switch]$NoBump
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Run-Step($m){ Write-Host "`n== $m ==" -ForegroundColor Cyan }
function RunCmd($m){
  if ($DryRun) { Write-Host "   [dry-run] $m" -ForegroundColor DarkGray; return 0 }
  Write-Host "   $m" -ForegroundColor DarkGray
  & powershell -NoProfile -Command $m
  if ($LASTEXITCODE -ne 0) { throw "command failed: $m (exit $LASTEXITCODE)" }
  return 0
}

Write-Host "=== dbs release ===" -ForegroundColor Magenta

# ---- 0. preflight: the package name must be the published name ----
$name = (node -p "require('./package.json').name")
if ($name -ne 'dsh-bgm-service') {
  throw "package.json name is '$name', expected 'dsh-bgm-service' (the unscoped name 'dbs' is already taken on npm)."
}

# ---- 1. version ----
if (-not $Version) { $Version = (node -p "require('./package.json').version") }
Write-Host "target version: $Version" -ForegroundColor Yellow
if (-not $DryRun) {
  if (-not $NoBump) {
    $current = (node -p "require('./package.json').version")
    if ($current -eq $Version) {
      Write-Host "   package.json is already $Version, skipping bump" -ForegroundColor DarkGray
    } else {
      Run-Step "bump version to $Version"
      RunCmd "npm version $Version --no-git-tag-version --cache .\.npm-cache"
    }
  }
} else { Write-Host "[dry-run] version untouched" }

# ---- 2. clean backups (they must never enter the npm tarball) ----
Run-Step "clean backup files"
RunCmd "Remove-Item -Force lib\*.bak-* -ErrorAction SilentlyContinue; Remove-Item -Force *.bak-* -ErrorAction SilentlyContinue"
RunCmd "git rm -q --cached lib/*.bak-* 2>&1 | Out-Null; exit 0"

# ---- 3. dry-run pack: show exactly what would be published ----
Run-Step "pack preview (npm pack --dry-run)"
RunCmd "npm pack --dry-run --cache .\.npm-cache"

# ---- 4. commit + tag ----
Run-Step "commit + tag"
RunCmd "git add -A"
$pending = & git status --porcelain
if ($pending) { RunCmd "git -c core.autocrlf=false commit -m 'release: v$Version'" }
else { Write-Host "   nothing to commit" -ForegroundColor DarkGray }
RunCmd "git tag -f v$Version"

# ---- 5. push ----
Run-Step "push to GitHub"
RunCmd "git push origin main"
RunCmd "git push origin v$Version -f"

# ---- 6. npm publish ----
if (-not $OnlyGit) {
  Run-Step "publish to npm"
  RunCmd "npm publish --cache .\.npm-cache"
}

# ---- 7. GitHub release ----
Run-Step "create GitHub release v$Version"
if (-not $OnlyGit) {
  $tag = "v$Version"
  $readme = Join-Path $PSScriptRoot 'README.md'
  $changelog = Join-Path $PSScriptRoot 'CHANGELOG.md'
  RunCmd "gh release create $tag --title 'DBS v$Version' --notes-file $changelog --target main"
  if (Test-Path $readme) { RunCmd "gh release upload $tag --clobber `"$readme`"" }
}

Write-Host "`nDone:" -ForegroundColor Green
Write-Host "  npm:     https://www.npmjs.com/package/dsh-bgm-service" -ForegroundColor Green
Write-Host "  GitHub:  https://github.com/LLYlab/DBS" -ForegroundColor Green
Write-Host "  Release: https://github.com/LLYlab/DBS/releases/tag/v$Version" -ForegroundColor Green
