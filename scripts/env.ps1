# Dot-source this file to get the portable toolchain on PATH:
#   . .\scripts\env.ps1
# Nothing is installed system-wide.
#
#   tools\                 the programs: Node, JDK, Gradle (and the Android SDK by default)
#   $BuildRoot             everything a build writes: caches, the configurator checkout,
#                          Gradle output. Defaults to tools\work.
#
# Machine specific settings go into scripts\env.local.ps1 (not under version control):
#
#   $env:AM32_BUILD_ROOT  = 'D:\am32-android-build'     # put the build work on a fast NTFS drive
#   $env:AM32_ANDROID_SDK = 'D:\some\android-sdk'       # reuse an Android SDK that is already installed

$ErrorActionPreference = 'Stop'

$global:ProjectRoot = Split-Path -Parent $PSScriptRoot
$global:ToolsDir    = Join-Path $ProjectRoot 'tools'

$localEnv = Join-Path $PSScriptRoot 'env.local.ps1'
if (Test-Path $localEnv) { . $localEnv }

$global:BuildRoot = if ($env:AM32_BUILD_ROOT) { $env:AM32_BUILD_ROOT } else { Join-Path $ToolsDir 'work' }
New-Item -ItemType Directory -Force $BuildRoot | Out-Null

$env:JAVA_HOME         = Join-Path $ToolsDir 'jdk'
$env:ANDROID_HOME      = if ($env:AM32_ANDROID_SDK) { $env:AM32_ANDROID_SDK } else { Join-Path $ToolsDir 'android-sdk' }
$env:ANDROID_SDK_ROOT  = $env:ANDROID_HOME
# caches and build output
$env:GRADLE_USER_HOME      = Join-Path $BuildRoot 'gradle-home'
$env:AM32_GRADLE_BUILD_DIR = Join-Path $BuildRoot 'gradle-build'
$env:ANDROID_USER_HOME     = Join-Path $BuildRoot 'android-user'
$env:ANDROID_AVD_HOME      = Join-Path $BuildRoot 'android-user\avd'
$env:COREPACK_HOME         = Join-Path $BuildRoot 'corepack'
$env:YARN_CACHE_FOLDER     = Join-Path $BuildRoot 'yarn-cache'
$env:YARN_ENABLE_GLOBAL_CACHE = 'false'
$env:npm_config_cache      = Join-Path $BuildRoot 'npm-cache'
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
$env:NUXT_TELEMETRY_DISABLED = '1'

$toolPaths = @(
    (Join-Path $ToolsDir 'node'),
    (Join-Path $env:JAVA_HOME 'bin'),
    (Join-Path $ToolsDir 'gradle\bin'),
    (Join-Path $env:ANDROID_HOME 'platform-tools'),
    (Join-Path $env:ANDROID_HOME 'cmdline-tools\latest\bin')
)
foreach ($p in $toolPaths) {
    if (($env:PATH -split ';') -notcontains $p) {
        $env:PATH = "$p;$env:PATH"
    }
}

# Runs a native program and fails when it exits non-zero. Tools like keytool, gradle and
# yarn write ordinary progress to stderr; with $ErrorActionPreference = 'Stop' PowerShell 5
# turns that into a terminating error as soon as the caller redirects output, hence the
# local 'Continue'.
function global:Invoke-Checked {
    param([string]$What, [scriptblock]$Command)
    $ErrorActionPreference = 'Continue'
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)" }
}
