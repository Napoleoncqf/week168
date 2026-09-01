param(
    [string]$AndroidSdk = "",
    [string]$Serial = "",
    [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-CommandSucceeded([string]$Step) {
    if ($LASTEXITCODE -ne 0) {
        throw "$Step 失败，退出码：$LASTEXITCODE"
    }
}

$ProjectRoot = [IO.Path]::GetFullPath($PSScriptRoot)
if ([string]::IsNullOrWhiteSpace($AndroidSdk)) {
    $SdkCandidates = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT)
    if ($env:LOCALAPPDATA) { $SdkCandidates += (Join-Path $env:LOCALAPPDATA "Android\Sdk") }
    $AndroidSdk = $SdkCandidates | Where-Object {
        $_ -and (Test-Path -LiteralPath (Join-Path $_ "platform-tools\adb.exe") -PathType Leaf)
    } | Select-Object -First 1
}
if ([string]::IsNullOrWhiteSpace($AndroidSdk)) {
    throw "未找到 Android SDK。请设置 ANDROID_HOME 或通过 -AndroidSdk 指定路径。"
}
$ApkPath = Join-Path $ProjectRoot "release\Week168.apk"
$Adb = Join-Path $AndroidSdk "platform-tools\adb.exe"

if (-not (Test-Path -LiteralPath $Adb -PathType Leaf)) {
    throw "未找到 adb：$Adb"
}
if (-not (Test-Path -LiteralPath $ApkPath -PathType Leaf)) {
    Write-Host "尚无 APK，先执行离线构建。"
    & (Join-Path $ProjectRoot "build.ps1") -AndroidSdk $AndroidSdk
    Assert-CommandSucceeded "APK 构建"
}

$DeviceLines = @(
    & $Adb devices |
        Select-Object -Skip 1 |
        Where-Object { $_ -match "\tdevice$" }
)
Assert-CommandSucceeded "读取设备列表"
if ($DeviceLines.Count -eq 0) {
    throw "没有检测到已授权的安卓设备。请连接手机并允许 USB 调试后重试。"
}

if ([string]::IsNullOrWhiteSpace($Serial)) {
    $Serial = ($DeviceLines[0] -split "\t")[0]
}

Write-Host "安装到设备：$Serial"
& $Adb -s $Serial install -r $ApkPath
Assert-CommandSucceeded "APK 安装"

if (-not $NoLaunch) {
    & $Adb -s $Serial shell am start -n "io.github.napoleoncqf.week168/.MainActivity"
    Assert-CommandSucceeded "应用启动"
}

Write-Host "安装完成。"
