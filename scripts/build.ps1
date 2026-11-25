# Builds the installable APK from scratch.
#
#   .\scripts\build.ps1                    everything: tools, web app, APK
#   .\scripts\build.ps1 -SkipWeb           keep the web app that is already in the assets
#   .\scripts\build.ps1 -WebRef master     build the newest upstream configurator
#
# Result: dist\AM32-Mobile-<version>.apk
#
# Firmware is not part of the APK: the app downloads it from am32.ca when it is needed
# and keeps it on the phone.

param(
    [switch]$SkipWeb,
    [string]$WebRef
)

. "$PSScriptRoot\env.ps1"

$Android = Join-Path $ProjectRoot 'android'
$Assets  = Join-Path $Android 'app\src\main\assets'
$Signing = Join-Path $Android 'signing'
$Dist    = Join-Path $ProjectRoot 'dist'

# --- toolchain --------------------------------------------------------------------------
$haveTools = (Test-Path (Join-Path $ToolsDir 'node\node.exe')) -and
             (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe')) -and
             (Test-Path (Join-Path $ToolsDir 'gradle\bin\gradle.bat')) -and
             (Test-Path (Join-Path $env:ANDROID_HOME 'platforms\android-35'))
if (-not $haveTools) {
    & "$PSScriptRoot\setup-tools.ps1"
}

# --- web app ----------------------------------------------------------------------------
if (-not $SkipWeb) {
    if ($WebRef) { & "$PSScriptRoot\build-web.ps1" -Ref $WebRef } else { & "$PSScriptRoot\build-web.ps1" }
}
if (-not (Test-Path (Join-Path $Assets 'www\index.html'))) {
    throw 'The web app is missing from the assets. Run without -SkipWeb.'
}

# --- signing key ------------------------------------------------------------------------
# Android only installs an update over an existing app when both are signed with the same
# key, so the key is created once and then reused. Keep a backup of android\signing.
$props = Join-Path $Signing 'keystore.properties'
if (-not (Test-Path $props)) {
    Write-Host 'Creating the signing key (android\signing) - keep a backup of that folder'
    New-Item -ItemType Directory -Force $Signing | Out-Null
    $bytes = New-Object byte[] 24
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $password = [Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', 'x'
    Invoke-Checked 'keytool' {
        keytool -genkeypair -keystore (Join-Path $Signing 'release.jks') -storetype PKCS12 `
            -alias am32mobile -keyalg RSA -keysize 2048 -validity 10000 `
            -storepass $password -keypass $password -dname 'CN=AM32 Mobile'
    }
    @(
        'storeFile=signing/release.jks',
        "storePassword=$password",
        'keyAlias=am32mobile',
        "keyPassword=$password"
    ) | Set-Content -Encoding ascii $props
}

# --- APK --------------------------------------------------------------------------------
Write-Host 'Building the APK'
Set-Content -Encoding ascii (Join-Path $Android 'local.properties') ("sdk.dir=" + ($env:ANDROID_HOME -replace '\\', '/'))
Invoke-Checked 'Gradle build' {
    gradle -p $Android --project-cache-dir (Join-Path $BuildRoot 'gradle-project-cache') --console=plain assembleRelease
}

$apk = Join-Path $env:AM32_GRADLE_BUILD_DIR 'app\outputs\apk\release\app-release.apk'
if (-not (Test-Path $apk)) { throw "Gradle reported success but $apk is missing." }

$version = (Select-String -Path (Join-Path $Android 'app\build.gradle.kts') -Pattern 'versionName\s*=\s*"([^"]+)"').Matches[0].Groups[1].Value
New-Item -ItemType Directory -Force $Dist | Out-Null
$out = Join-Path $Dist "AM32-Mobile-$version.apk"
Copy-Item -Force $apk $out

Write-Host ''
Write-Host ("APK: $out ({0:N1} MB)" -f ((Get-Item $out).Length / 1MB))
