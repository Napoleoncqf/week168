param(
    # 留空：有 editions/personal.json 时构建个人版，否则构建通用版。
    [string]$Edition = "",
    [string]$AndroidSdk = "",
    [string]$BuildToolsVersion = "35.0.0",
    [string]$PlatformVersion = "",
    [int]$VersionCode = 0,
    [string]$VersionName = "",
    [string]$SigningConfig = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-CommandSucceeded([string]$Step) {
    if ($LASTEXITCODE -ne 0) {
        throw "$Step 失败，退出码：$LASTEXITCODE"
    }
}

function Require-File([string]$Path, [string]$Description) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "缺少$Description：$Path"
    }
}

function Get-ApkSignerDigest([string]$Apksigner, [string]$ApkPath) {
    $SignerOutput = @(& $Apksigner verify --print-certs $ApkPath 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "无法验证既有 APK 的签名：$ApkPath"
    }
    $Match = [regex]::Match(
        ($SignerOutput -join "`n"),
        "Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F]{64})"
    )
    if (-not $Match.Success) {
        throw "无法读取 APK 签名证书 SHA-256：$ApkPath"
    }
    return $Match.Groups[1].Value.ToLowerInvariant()
}

function Get-ApkVersionCode([string]$Aapt2, [string]$ApkPath) {
    $BadgingOutput = @(& $Aapt2 dump badging $ApkPath 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "无法读取既有 APK 的版本：$ApkPath"
    }
    $Match = [regex]::Match(($BadgingOutput -join "`n"), "versionCode='([0-9]+)'")
    if (-not $Match.Success) {
        throw "既有 APK 缺少可识别的 VersionCode：$ApkPath"
    }
    return [long]::Parse($Match.Groups[1].Value, [Globalization.CultureInfo]::InvariantCulture)
}

function Get-KeystoreSignerDigest(
    [string]$Keytool,
    [string]$KeystorePath,
    [string]$StorePassword,
    [string]$Alias
) {
    $KeyOutput = @(& $Keytool `
        -list `
        -v `
        -keystore $KeystorePath `
        -storepass $StorePassword `
        -alias $Alias `
        2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "无法读取长期签名密钥：$KeystorePath"
    }
    $Match = [regex]::Match(($KeyOutput -join "`n"), "SHA256:\s*([0-9a-fA-F:]{64,})")
    if (-not $Match.Success) {
        throw "无法读取签名密钥证书 SHA-256：$KeystorePath"
    }
    $Digest = $Match.Groups[1].Value.Replace(":", "").ToLowerInvariant()
    if ($Digest.Length -ne 64) {
        throw "签名密钥证书 SHA-256 长度异常：$KeystorePath"
    }
    return $Digest
}

function Invoke-OfflineBuild([string]$ProjectRoot, [string]$DisplayProjectRoot) {
if ($VersionCode -le 0 -or $VersionCode -gt 2100000000) {
    throw "VersionCode 必须在 1 到 2100000000 之间"
}
if ([string]::IsNullOrWhiteSpace($VersionName)) {
    throw "VersionName 不能为空"
}
$AndroidRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot "android"))
$BuildRoot = [IO.Path]::GetFullPath((Join-Path $AndroidRoot "build"))
# 源码只有一份；scripts/edition.js 按版本配置生成清单、资源、assets 和改写包名后的 Java。
$StageRoot = Join-Path $BuildRoot "stage"
$ManifestPath = Join-Path $StageRoot "AndroidManifest.xml"
$ResourceRoot = Join-Path $StageRoot "res"
$AssetRoot = Join-Path $StageRoot "assets"
$JavaSourceRoot = Join-Path $StageRoot "java"
$DistRoot = Join-Path $AndroidRoot "dist"
$ReleaseRoot = Join-Path $ProjectRoot "release"
$KeystorePath = $SigningKeystorePath
$RealPrefix = $DisplayProjectRoot.TrimEnd("\") + "\"
if ($KeystorePath.StartsWith($RealPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    # 项目内的密钥也走 ASCII 盘符，避免 Java 工具处理中文路径。
    $KeystorePath = Join-Path $ProjectRoot $KeystorePath.Substring($RealPrefix.Length)
}
$KeystoreRoot = Split-Path -Parent $KeystorePath
$ReleaseApkName = [string]$EditionConfig.releaseApk
$FinalReleaseApk = Join-Path $ReleaseRoot $ReleaseApkName

if (-not $BuildRoot.StartsWith($AndroidRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "构建目录安全检查失败：$BuildRoot"
}

$BuildToolsRoot = Join-Path $AndroidSdk "build-tools\$BuildToolsVersion"
$AndroidJar = Join-Path $AndroidSdk "platforms\$PlatformVersion\android.jar"
$Aapt2 = Join-Path $BuildToolsRoot "aapt2.exe"
$D8 = Join-Path $BuildToolsRoot "d8.bat"
$Zipalign = Join-Path $BuildToolsRoot "zipalign.exe"
$Apksigner = Join-Path $BuildToolsRoot "apksigner.bat"

Require-File $AndroidJar "Android 平台库"
Require-File $Aapt2 "aapt2"
Require-File $D8 "d8"
Require-File $Zipalign "zipalign"
Require-File $Apksigner "apksigner"

$Node = (Get-Command node -ErrorAction Stop).Source
$Javac = (Get-Command javac -ErrorAction Stop).Source
$Jar = (Get-Command jar -ErrorAction Stop).Source
$Keytool = (Get-Command keytool -ErrorAction Stop).Source

if (Test-Path -LiteralPath $FinalReleaseApk -PathType Leaf) {
    $ExistingReleaseVersionCode = Get-ApkVersionCode $Aapt2 $FinalReleaseApk
    Write-Host "既有发行 APK VersionCode：$ExistingReleaseVersionCode"
    if ([long]$VersionCode -lt $ExistingReleaseVersionCode) {
        throw "VersionCode 不得从 $ExistingReleaseVersionCode 降级到 $VersionCode。请显式传入不小于既有发行版的 VersionCode。"
    }
}

if (Test-Path -LiteralPath $BuildRoot) {
    Remove-Item -LiteralPath $BuildRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $BuildRoot, $DistRoot, $ReleaseRoot, $KeystoreRoot | Out-Null

$CompiledResources = Join-Path $BuildRoot "compiled-resources.zip"
$GeneratedRoot = Join-Path $BuildRoot "generated"
$ClassesRoot = Join-Path $BuildRoot "classes"
$ClassesJar = Join-Path $BuildRoot "classes.jar"
$DexRoot = Join-Path $BuildRoot "dex"
$ResourceApk = Join-Path $BuildRoot "resources-unsigned.apk"
$AlignedApk = Join-Path $BuildRoot "aligned-unsigned.apk"
$OutputApk = Join-Path $DistRoot $ReleaseApkName

New-Item -ItemType Directory -Force -Path $GeneratedRoot, $ClassesRoot, $DexRoot | Out-Null

Write-Host "[0/7] 生成 $Edition 版本源码"
& $Node (Join-Path $ProjectRoot "scripts\edition.js") stage $Edition $StageRoot
Assert-CommandSucceeded "版本源码生成"
Require-File $ManifestPath "AndroidManifest.xml"
foreach ($AssetName in @("index.html", "app.js", "core.js", "styles.css", "edition.js")) {
    Require-File (Join-Path $AssetRoot $AssetName) "前端文件 $AssetName"
}

Write-Host "[1/7] 编译 Android 资源"
& $Aapt2 compile --dir $ResourceRoot -o $CompiledResources
Assert-CommandSucceeded "资源编译"

Write-Host "[2/7] 打包清单、资源与离线页面"
& $Aapt2 link `
    -o $ResourceApk `
    --manifest $ManifestPath `
    -I $AndroidJar `
    --java $GeneratedRoot `
    -A $AssetRoot `
    --min-sdk-version 26 `
    --target-sdk-version ([int]$EditionConfig.targetSdk) `
    --version-code $VersionCode `
    --version-name $VersionName `
    --auto-add-overlay `
    $CompiledResources
Assert-CommandSucceeded "资源链接"

Write-Host "[3/7] 编译 Java 原生壳"
$JavaSources = @(
    Get-ChildItem -LiteralPath $JavaSourceRoot -Recurse -Filter "*.java" | ForEach-Object FullName
    Get-ChildItem -LiteralPath $GeneratedRoot -Recurse -Filter "*.java" | ForEach-Object FullName
)
if ($JavaSources.Count -eq 0) {
    throw "没有找到 Java 源文件"
}
& $Javac `
    -encoding UTF-8 `
    -source 8 `
    -target 8 `
    -bootclasspath $AndroidJar `
    -classpath $AndroidJar `
    -d $ClassesRoot `
    @JavaSources
Assert-CommandSucceeded "Java 编译"

Write-Host "[4/7] 生成 Android DEX"
& $Jar --create --file $ClassesJar -C $ClassesRoot .
Assert-CommandSucceeded "Java 归档"
& $D8 --release --min-api 26 --lib $AndroidJar --output $DexRoot $ClassesJar
Assert-CommandSucceeded "DEX 生成"
& $Jar --update --file $ResourceApk -C $DexRoot classes.dex
Assert-CommandSucceeded "DEX 写入 APK"

Write-Host "[5/7] 对齐 APK"
& $Zipalign -f -p 4 $ResourceApk $AlignedApk
Assert-CommandSucceeded "APK 对齐"

if (-not (Test-Path -LiteralPath $KeystorePath -PathType Leaf)) {
    if ((Test-Path -LiteralPath $FinalReleaseApk -PathType Leaf) -or
        (Test-Path -LiteralPath $OutputApk -PathType Leaf)) {
        throw "发现既有发行 APK，但长期签名密钥缺失。为避免生成无法覆盖安装的新签名，构建已停止。请恢复 $KeystorePath。"
    }
    Write-Host "[6/7] 首次生成本机长期签名密钥"
    & $Keytool `
        -genkeypair `
        -keystore $KeystorePath `
        -storetype JKS `
        -storepass $SigningStorePassword `
        -keypass $SigningKeyPassword `
        -alias $SigningAlias `
        -keyalg RSA `
        -keysize 2048 `
        -validity 10000 `
        -dname "CN=$($EditionConfig.appName) Release, OU=Local, O=Week168" `
        -noprompt
    Assert-CommandSucceeded "签名密钥生成"
} else {
    Write-Host "[6/7] 使用现有长期签名密钥"
}

$KeystoreSignerDigest = Get-KeystoreSignerDigest $Keytool $KeystorePath $SigningStorePassword $SigningAlias
$ExistingReleaseSignerDigest = $null
if (Test-Path -LiteralPath $FinalReleaseApk -PathType Leaf) {
    $ExistingReleaseSignerDigest = Get-ApkSignerDigest $Apksigner $FinalReleaseApk
    Write-Host "既有发行 APK 签名证书 SHA-256：$ExistingReleaseSignerDigest"
    if ($ExistingReleaseSignerDigest -ne $KeystoreSignerDigest) {
        throw "既有发行 APK 与长期签名密钥身份不一致，已停止构建，原发行文件未改动。"
    }
}
Write-Host "签名密钥证书 SHA-256：$KeystoreSignerDigest"

Write-Host "[7/7] 签名并验证 APK"
if (Test-Path -LiteralPath $OutputApk) {
    Remove-Item -LiteralPath $OutputApk -Force
}
& $Apksigner sign `
    --ks $KeystorePath `
    --ks-key-alias $SigningAlias `
    --ks-pass "pass:$SigningStorePassword" `
    --key-pass "pass:$SigningKeyPassword" `
    --v1-signing-enabled true `
    --v2-signing-enabled true `
    --v3-signing-enabled true `
    --out $OutputApk `
    $AlignedApk
Assert-CommandSucceeded "APK 签名"

& $Apksigner verify --verbose --print-certs $OutputApk
Assert-CommandSucceeded "APK 签名验证"
$NewSignerDigest = Get-ApkSignerDigest $Apksigner $OutputApk
if ($NewSignerDigest -ne $KeystoreSignerDigest) {
    throw "新 APK 的签名与长期签名密钥不一致，发行文件未更新。"
}
if ($null -ne $ExistingReleaseSignerDigest -and
    $NewSignerDigest -ne $ExistingReleaseSignerDigest) {
    throw "新 APK 与既有发行 APK 的签名身份不一致，发行文件未更新。"
}

Write-Host "发布最终 APK（原子替换）"
$ReleaseTempApk = Join-Path $ReleaseRoot "$ReleaseApkName.tmp"
if (Test-Path -LiteralPath $ReleaseTempApk) {
    Remove-Item -LiteralPath $ReleaseTempApk -Force
}
Copy-Item -LiteralPath $OutputApk -Destination $ReleaseTempApk -Force
if (Test-Path -LiteralPath $FinalReleaseApk -PathType Leaf) {
    $ReleaseBackupApk = Join-Path $BuildRoot "previous-release.apk"
    [IO.File]::Replace($ReleaseTempApk, $FinalReleaseApk, $ReleaseBackupApk, $true)
} else {
    [IO.File]::Move($ReleaseTempApk, $FinalReleaseApk)
}

& $Apksigner verify --verbose --print-certs $FinalReleaseApk
Assert-CommandSucceeded "最终发行 APK 签名验证"
$FinalSignerDigest = Get-ApkSignerDigest $Apksigner $FinalReleaseApk
if ($FinalSignerDigest -ne $KeystoreSignerDigest) {
    throw "原子发布后的 APK 签名身份校验失败。"
}
& $Aapt2 dump badging $FinalReleaseApk
Assert-CommandSucceeded "最终发行 APK 清单验证"

$Hash = (Get-FileHash -LiteralPath $FinalReleaseApk -Algorithm SHA256).Hash
$ChecksumPath = Join-Path $ReleaseRoot "$ReleaseApkName.sha256"
[IO.File]::WriteAllText($ChecksumPath, "$Hash *$ReleaseApkName`n", [Text.UTF8Encoding]::new($false))
$SizeMb = [Math]::Round((Get-Item -LiteralPath $FinalReleaseApk).Length / 1MB, 2)
$DisplayOutputApk = Join-Path $DisplayProjectRoot "release\$ReleaseApkName"
Write-Host ""
Write-Host "构建完成（$Edition）：$DisplayOutputApk"
Write-Host "大小：$SizeMb MB"
Write-Host "SHA-256：$Hash"
Write-Host "签名证书 SHA-256：$FinalSignerDigest"
}

# Android 的 aapt2 在部分 Windows 环境中不能可靠处理中文目录。把项目临时映射到
# 一个仅含 ASCII 的盘符；所有源文件和产物仍然位于原项目目录中。
$RealProjectRoot = [IO.Path]::GetFullPath($PSScriptRoot)

if ([string]::IsNullOrWhiteSpace($Edition)) {
    $Edition = if (Test-Path -LiteralPath (Join-Path $RealProjectRoot "editions\personal.json")) { "personal" } else { "general" }
}
if ($Edition -notmatch "^[a-z][a-z0-9-]{0,30}$") { throw "无效的版本名：$Edition" }
$EditionPath = Join-Path $RealProjectRoot "editions\$Edition.json"
Require-File $EditionPath "版本配置"
$EditionConfig = Get-Content -LiteralPath $EditionPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($VersionCode -eq 0) { $VersionCode = [int]$EditionConfig.versionCode }
if ([string]::IsNullOrWhiteSpace($VersionName)) { $VersionName = [string]$EditionConfig.versionName }
if ([string]::IsNullOrWhiteSpace($PlatformVersion)) { $PlatformVersion = [string]$EditionConfig.platform }

if ([string]::IsNullOrWhiteSpace($AndroidSdk)) {
    $SdkCandidates = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, "D:\Android\Sdk")
    if ($env:LOCALAPPDATA) { $SdkCandidates += (Join-Path $env:LOCALAPPDATA "Android\Sdk") }
    $AndroidSdk = $SdkCandidates | Where-Object {
        $_ -and (Test-Path -LiteralPath (Join-Path $_ "platforms\$PlatformVersion\android.jar") -PathType Leaf)
    } | Select-Object -First 1
}
if ([string]::IsNullOrWhiteSpace($AndroidSdk)) {
    throw "未找到 Android SDK $PlatformVersion。请设置 ANDROID_HOME 或通过 -AndroidSdk 指定路径。"
}

if ([string]::IsNullOrWhiteSpace($SigningConfig)) {
    $SigningConfig = [string]$EditionConfig.signingConfig
}
if (-not [IO.Path]::IsPathRooted($SigningConfig)) {
    $SigningConfig = Join-Path $RealProjectRoot $SigningConfig
}
Require-File $SigningConfig "本机签名配置（参考 signing.example.psd1）"
$SigningSettings = Import-PowerShellDataFile -LiteralPath $SigningConfig
foreach ($RequiredKey in @("KeystorePath", "Alias", "StorePassword", "KeyPassword")) {
    if ((-not $SigningSettings.ContainsKey($RequiredKey)) -or
        [string]::IsNullOrWhiteSpace([string]$SigningSettings[$RequiredKey])) {
        throw "本机签名配置缺少 $RequiredKey"
    }
}
$SigningKeystorePath = [string]$SigningSettings.KeystorePath
if (-not [IO.Path]::IsPathRooted($SigningKeystorePath)) {
    # 相对路径按配置文件所属项目解析：配置位于 <项目>\android\keystore\ 时以该项目为根，
    # 否则以本仓库为根。这样可直接引用另一个工作副本里的签名配置。
    $SigningConfigDir = Split-Path -Parent ([IO.Path]::GetFullPath($SigningConfig))
    $KeystoreBase = $RealProjectRoot
    if ((Split-Path -Leaf $SigningConfigDir) -eq "keystore" -and
        (Split-Path -Leaf (Split-Path -Parent $SigningConfigDir)) -eq "android") {
        $KeystoreBase = Split-Path -Parent (Split-Path -Parent $SigningConfigDir)
    }
    $SigningKeystorePath = Join-Path $KeystoreBase $SigningKeystorePath
}
$SigningKeystorePath = [IO.Path]::GetFullPath($SigningKeystorePath)
$SigningAlias = [string]$SigningSettings.Alias
$SigningStorePassword = [string]$SigningSettings.StorePassword
$SigningKeyPassword = [string]$SigningSettings.KeyPassword

$SubstDrive = $null
foreach ($DriveLetter in @("W", "V", "U", "T", "S", "R")) {
    $Candidate = "${DriveLetter}:"
    if (-not (Test-Path -LiteralPath "${Candidate}\")) {
        $SubstDrive = $Candidate
        break
    }
}
if ($null -eq $SubstDrive) {
    throw "找不到可用于离线构建的临时盘符（已检查 R: 至 W:）"
}

& subst.exe $SubstDrive $RealProjectRoot
Assert-CommandSucceeded "创建临时构建盘符"
try {
    # 签名路径在映射前已解析为真实路径；映射后仍可直接访问。
    Invoke-OfflineBuild "${SubstDrive}\" $RealProjectRoot
} finally {
    & subst.exe $SubstDrive /d | Out-Null
}
