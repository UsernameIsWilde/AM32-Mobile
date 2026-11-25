# Builds the configurator web app from source and copies the static site into the APK assets.
#
#   .\scripts\build-web.ps1                 build the pinned upstream commit
#   .\scripts\build-web.ps1 -Ref master     build the newest upstream code instead
#
# Output: android\app\src\main\assets\www

param(
    # Commit of https://github.com/am32-firmware/am32-configurator this app is tested with.
    [string]$Ref = 'e11c42e7840b388b40091767f1abb8e58c161f88'
)

. "$PSScriptRoot\env.ps1"

$Repo = 'https://github.com/am32-firmware/am32-configurator'
$Src  = Join-Path $BuildRoot 'web-src'
$Www  = Join-Path $ProjectRoot 'android\app\src\main\assets\www'
$Dl   = Join-Path $BuildRoot 'downloads'

# --- source -----------------------------------------------------------------------------
# The source is fetched as an archive, not cloned: git refuses to work in a repository on
# a drive that does not record file ownership (exFAT), and no history is needed anyway.
if ($Ref -match '^[0-9a-f]{40}$') {
    $sha = $Ref
} else {
    $line = (& git ls-remote $Repo $Ref) | Select-Object -First 1
    if (-not $line) { throw "Cannot resolve '$Ref' in $Repo" }
    $sha = ($line -split '\s+')[0]
}
Write-Host "Source: $Repo @ $($sha.Substring(0, 7))"

New-Item -ItemType Directory -Force $Dl, $Src | Out-Null
$archive = Join-Path $Dl "configurator-$sha.tar.gz"
if (-not (Test-Path $archive)) {
    Invoke-Checked 'source download' { curl.exe -fsSL -o "$archive.part" "$Repo/archive/$sha.tar.gz" }
    Move-Item -Force "$archive.part" $archive
}

# Start from pristine sources every time, but keep node_modules: reinstalling takes minutes.
Get-ChildItem -Force $Src | Where-Object { $_.Name -notin @('node_modules', '.yarn') } |
    Remove-Item -Recurse -Force
Invoke-Checked 'source extract' { tar.exe -xmzf $archive -C $Src --strip-components=1 }
Invoke-Checked 'patch-web' { node (Join-Path $PSScriptRoot 'patch-web.mjs') $Src }

# --- build ------------------------------------------------------------------------------
# shown in the footer of the app; upstream reads it from git, which is not available here
$env:NUXT_PUBLIC_GIT_HASH = $sha.Substring(0, 7)

Push-Location $Src
try {
    # The first run downloads yarn itself. On exFAT corepack's own install step sometimes
    # fails once and then works, so give it a second go before treating it as an error.
    try {
        Invoke-Checked 'corepack (yarn download)' { corepack yarn --version | Out-Null }
    } catch {
        Invoke-Checked 'corepack (yarn download)' { corepack yarn --version | Out-Null }
    }

    Write-Host 'Installing dependencies (yarn)'
    Invoke-Checked 'yarn install' { corepack yarn install --immutable }

    Write-Host 'Generating the static site (nuxt generate)'
    Invoke-Checked 'nuxt generate' { corepack yarn nuxt generate }
} finally {
    Pop-Location
}

# --- copy into the APK ------------------------------------------------------------------
$Public = Join-Path $Src '.output\public'
if (-not (Test-Path (Join-Path $Public 'index.html'))) { throw "nuxt generate produced no index.html in $Public" }

if (Test-Path $Www) { Remove-Item -Recurse -Force $Www }
New-Item -ItemType Directory -Force $Www | Out-Null
Copy-Item -Recurse -Force (Join-Path $Public '*') $Www

$all   = Get-ChildItem -Recurse -File $Www
$size  = [math]::Round((($all | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host "Web app: $($all.Count) files, $size MB -> $Www"
