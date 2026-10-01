param(
    # 留空：有 editions/personal.json 时构建个人版，否则构建通用版。
    [string]$Edition = "",
    [string]$AndroidSdk = "D:\Android\Sdk",
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
if ([string]::IsNullOrWhiteSpace($Edition)) {
    $Edition = if (Test-Path -LiteralPath (Join-Path $ProjectRoot "editions\personal.json")) { "personal" } else { "general" }
}
if ($Edition -notmatch "^[a-z][a-z0-9-]{0,30}$") { throw "无效的版本名：$Edition" }
$EditionConfig = Get-Content -LiteralPath (Join-Path $ProjectRoot "editions\$Edition.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$ApkPath = Join-Path $ProjectRoot "release\$($EditionConfig.releaseApk)"
$Adb = Join-Path $AndroidSdk "platform-tools\adb.exe"

if (-not (Test-Path -LiteralPath $Adb -PathType Leaf)) {
    throw "未找到 adb：$Adb"
}
if (-not (Test-Path -LiteralPath $ApkPath -PathType Leaf)) {
    Write-Host "尚无 APK，先执行离线构建。"
    & (Join-Path $ProjectRoot "build.ps1") -Edition $Edition -AndroidSdk $AndroidSdk
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
    & $Adb -s $Serial shell am start -n "$($EditionConfig.packageName)/.MainActivity"
    Assert-CommandSucceeded "应用启动"
}

Write-Host "安装完成。"
