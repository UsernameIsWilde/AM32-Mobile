# Downloads the portable build toolchain into tools\ (Node, JDK 17, Gradle, Android SDK).
# Safe to re-run: every step is skipped when its output already exists.
#
# The Android SDK can only be installed after accepting Google's licence agreements.
# By default they are shown and you answer them yourself; -AcceptAndroidLicenses answers
# "yes" to all of them for you.

param(
    [switch]$AcceptAndroidLicenses
)

. "$PSScriptRoot\env.ps1"
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$GradleVersion   = '8.11.1'
$CmdlineToolsZip = 'commandlinetools-win-11076708_latest.zip'
$SdkPackages     = @('platform-tools', 'platforms;android-35', 'build-tools;35.0.0')

$dl = Join-Path $ToolsDir '_downloads'
New-Item -ItemType Directory -Force $ToolsDir, $dl | Out-Null

function Get-File($url, $dest) {
    if (Test-Path $dest) { return }
    Write-Host "  downloading $url"
    $tmp = "$dest.part"
    & curl.exe -fSL --retry 3 -o $tmp $url
    if ($LASTEXITCODE -ne 0) { throw "download failed: $url" }
    Move-Item -Force $tmp $dest
}

# Extracts a zip that contains a single top-level folder and renames that folder to $target.
function Expand-Single($zip, $target) {
    $tmp = Join-Path $dl ([IO.Path]::GetFileNameWithoutExtension($zip) + '_x')
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    # -m: do not restore modification times (exFAT drives reject them and tar then fails)
    & tar.exe -xmf $zip -C (New-Item -ItemType Directory -Force $tmp).FullName
    if ($LASTEXITCODE -ne 0) { throw "extract failed: $zip" }
    $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
    Move-Item $inner.FullName $target
    Remove-Item -Recurse -Force $tmp
}

# --- Node.js 20 LTS -------------------------------------------------------------------
if (-not (Test-Path (Join-Path $ToolsDir 'node\node.exe'))) {
    Write-Host 'Node.js 20'
    $sums = (& curl.exe -fsSL 'https://nodejs.org/dist/latest-v20.x/SHASUMS256.txt') -join "`n"
    if ($sums -notmatch '(node-v20\.[\d.]+-win-x64\.zip)') { throw 'cannot find the Node 20 zip name' }
    $name = $Matches[1]
    $zip = Join-Path $dl $name
    Get-File "https://nodejs.org/dist/latest-v20.x/$name" $zip
    Expand-Single $zip (Join-Path $ToolsDir 'node')
}

# --- JDK 17 (Eclipse Temurin) ---------------------------------------------------------
if (-not (Test-Path (Join-Path $ToolsDir 'jdk\bin\java.exe'))) {
    Write-Host 'JDK 17'
    $zip = Join-Path $dl 'jdk17.zip'
    Get-File 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse' $zip
    Expand-Single $zip (Join-Path $ToolsDir 'jdk')
}

# --- Gradle ---------------------------------------------------------------------------
if (-not (Test-Path (Join-Path $ToolsDir 'gradle\bin\gradle.bat'))) {
    Write-Host "Gradle $GradleVersion"
    $zip = Join-Path $dl "gradle-$GradleVersion-bin.zip"
    Get-File "https://services.gradle.org/distributions/gradle-$GradleVersion-bin.zip" $zip
    Expand-Single $zip (Join-Path $ToolsDir 'gradle')
}

# --- Android SDK ----------------------------------------------------------------------
$sdkmanager = Join-Path $env:ANDROID_HOME 'cmdline-tools\latest\bin\sdkmanager.bat'
if (-not (Test-Path $sdkmanager)) {
    Write-Host 'Android command line tools'
    $zip = Join-Path $dl $CmdlineToolsZip
    Get-File "https://dl.google.com/android/repository/$CmdlineToolsZip" $zip
    New-Item -ItemType Directory -Force (Join-Path $env:ANDROID_HOME 'cmdline-tools') | Out-Null
    Expand-Single $zip (Join-Path $env:ANDROID_HOME 'cmdline-tools\latest')
}

$needSdk = -not (Test-Path (Join-Path $env:ANDROID_HOME 'platforms\android-35')) -or
           -not (Test-Path (Join-Path $env:ANDROID_HOME 'build-tools\35.0.0')) -or
           -not (Test-Path (Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'))
if ($needSdk) {
    Write-Host 'Android SDK packages'
    if ($AcceptAndroidLicenses) {
        # cmd does the piping: PowerShell 5 does not feed stdin to a .bat reliably
        & cmd.exe /c "(for /L %i in (1,1,60) do @echo y) | `"$sdkmanager`" --licenses >nul"
    } else {
        # Google's licence agreements are shown here and have to be answered with "y".
        & $sdkmanager --licenses
    }
    & $sdkmanager @SdkPackages
    $missing = @('platforms\android-35', 'build-tools\35.0.0', 'platform-tools\adb.exe') |
        Where-Object { -not (Test-Path (Join-Path $env:ANDROID_HOME $_)) }
    if ($missing) {
        throw "Android SDK packages were not installed ($($missing -join ', ')). Were the licence agreements accepted?"
    }
}

Write-Host ''
Write-Host 'Toolchain ready:'
Write-Host ('  node   ' + (& node --version))
Write-Host ('  java   ' + ((& java --version)[0]))
Write-Host ('  gradle ' + (((& gradle --version) -match '^Gradle ') -join ''))
Write-Host ('  sdk    ' + $env:ANDROID_HOME)
