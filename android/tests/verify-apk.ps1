param(
    # 留空：有 editions/personal.json 时构建个人版，否则构建通用版。
    [string]$Edition = "",
    [string]$AndroidSdk = "D:\Android\Sdk",
    [string]$BuildToolsVersion = "35.0.0",
    # 0 / 空字符串表示沿用 editions\<edition>.json 中的值。
    [int]$ExpectedVersionCode = 0,
    [string]$ExpectedVersionName = "",
    [string]$ExpectedSignerSha256 = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-ExitCode([string]$Step) {
    if ($LASTEXITCODE -ne 0) {
        throw "$Step 失败，退出码：$LASTEXITCODE"
    }
}

function Assert-Contains([string]$Text, [string]$Needle, [string]$Message) {
    if (-not $Text.Contains($Needle)) {
        throw "$Message（未找到：$Needle）"
    }
}

function Require-File([string]$Path, [string]$Description) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "缺少$Description：$Path"
    }
}

$RealProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
if ([string]::IsNullOrWhiteSpace($Edition)) {
    $Edition = if (Test-Path -LiteralPath (Join-Path $RealProjectRoot "editions\personal.json")) { "personal" } else { "general" }
}
if ($Edition -notmatch "^[a-z][a-z0-9-]{0,30}$") { throw "无效的版本名：$Edition" }
$EditionConfig = Get-Content -LiteralPath (Join-Path $RealProjectRoot "editions\$Edition.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if ($ExpectedVersionCode -eq 0) { $ExpectedVersionCode = [int]$EditionConfig.versionCode }
if ([string]::IsNullOrWhiteSpace($ExpectedVersionName)) { $ExpectedVersionName = [string]$EditionConfig.versionName }
if ([string]::IsNullOrWhiteSpace($ExpectedSignerSha256)) { $ExpectedSignerSha256 = [string]$EditionConfig.expectedSignerSha256 }
$PackageName = [string]$EditionConfig.packageName
$ReleaseApkName = [string]$EditionConfig.releaseApk
$AiImport = [bool]$EditionConfig.features.aiImport

$ExpectedSigner = $ExpectedSignerSha256.Replace(":", "").ToLowerInvariant()
if ($ExpectedSigner -eq "") {
    Write-Warning "未指定期望签名（editions\$Edition.json 的 expectedSignerSha256 为空），跳过签名身份比对。"
} elseif ($ExpectedSigner -notmatch "^[0-9a-f]{64}$") {
    throw "ExpectedSignerSha256 必须是 64 位十六进制 SHA-256"
}
if ($ExpectedVersionCode -le 0) {
    throw "ExpectedVersionCode 必须为正整数"
}
if ([string]::IsNullOrWhiteSpace($ExpectedVersionName)) {
    throw "ExpectedVersionName 不能为空"
}

$SubstDrive = $null
foreach ($DriveLetter in @("Q", "P", "O", "N", "M", "L")) {
    $Candidate = "${DriveLetter}:"
    if (-not (Test-Path -LiteralPath "${Candidate}\")) {
        $SubstDrive = $Candidate
        break
    }
}
if ($null -eq $SubstDrive) {
    throw "找不到可用于 APK 验证的临时盘符（已检查 L: 至 Q:）"
}

& subst.exe $SubstDrive $RealProjectRoot
Assert-ExitCode "创建验证盘符"
try {
    $Apk = "${SubstDrive}\release\$ReleaseApkName"
    $DistApk = "${SubstDrive}\android\dist\$ReleaseApkName"
    # build.ps1 生成的本版本源码（含 edition.js 与改写包名后的清单）。
    $StageRoot = "${SubstDrive}\android\build\stage"
    Require-File "$StageRoot\AndroidManifest.xml" "构建暂存清单（请先运行 build.ps1 -Edition $Edition）"
    $BuildTools = Join-Path $AndroidSdk "build-tools\$BuildToolsVersion"
    $Zipalign = Join-Path $BuildTools "zipalign.exe"
    $Apksigner = Join-Path $BuildTools "apksigner.bat"
    $Aapt2 = Join-Path $BuildTools "aapt2.exe"
    $Jar = (Get-Command jar -ErrorAction Stop).Source

    Require-File $Apk "待验证 APK"
    Require-File $Zipalign "zipalign"
    Require-File $Apksigner "apksigner"
    Require-File $Aapt2 "aapt2"
    $ReleaseHash = (Get-FileHash -LiteralPath $Apk -Algorithm SHA256).Hash
    if (Test-Path -LiteralPath $DistApk -PathType Leaf) {
        $DistHash = (Get-FileHash -LiteralPath $DistApk -Algorithm SHA256).Hash
        if ($ReleaseHash -ne $DistHash) {
            throw "原子发布文件与构建 APK 内容不一致"
        }
    } else {
        Write-Host "未发现可选的 dist 中间产物；继续独立验证 release APK。"
    }

    & $Zipalign -c -p 4 $Apk
    Assert-ExitCode "APK 对齐验证"

    $SignatureOutput = (& $Apksigner verify --verbose --print-certs $Apk 2>&1) -join "`n"
    Assert-ExitCode "APK 签名验证"
    $SignerMatch = [regex]::Match(
        $SignatureOutput,
        "Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F]{64})"
    )
    if (-not $SignerMatch.Success) {
        throw "无法读取 APK 签名证书 SHA-256"
    }
    $ActualSigner = $SignerMatch.Groups[1].Value.ToLowerInvariant()
    Write-Host "APK 签名证书 SHA-256：$ActualSigner"
    if ($ExpectedSigner -ne "" -and $ActualSigner -ne $ExpectedSigner) {
        throw "APK 签名身份错误。期望：$ExpectedSigner；实际：$ActualSigner"
    }

    $Badging = (& $Aapt2 dump badging $Apk) -join "`n"
    Assert-ExitCode "APK 基本信息读取"
    Assert-Contains $Badging "package: name='$PackageName'" "应用包名错误"
    Assert-Contains $Badging "versionCode='$ExpectedVersionCode'" "VersionCode 错误"
    Assert-Contains $Badging "versionName='$ExpectedVersionName'" "VersionName 错误"
    Assert-Contains $Badging "minSdkVersion:'26'" "最低 Android 版本错误"
    Assert-Contains $Badging "targetSdkVersion:'$($EditionConfig.targetSdk)'" "目标 Android 版本错误"
    Assert-Contains $Badging "launchable-activity: name='$PackageName.MainActivity'" "主页面未声明"

    $Permissions = (& $Aapt2 dump permissions $Apk) -join "`n"
    Assert-ExitCode "APK 权限读取"
    $ExpectedPermissions = @(
        "android.permission.POST_NOTIFICATIONS",
        "android.permission.RECEIVE_BOOT_COMPLETED"
    )
    # 只有启用文字识别的版本申请网络权限。
    if ($AiImport) { $ExpectedPermissions += "android.permission.INTERNET" }
    $ExpectedPermissions = @($ExpectedPermissions | Sort-Object)
    $ActualPermissions = @(
        [regex]::Matches($Permissions, "uses-permission(?:-sdk-[0-9]+)?: name='([^']+)'") |
            ForEach-Object { $_.Groups[1].Value } |
            Sort-Object -Unique
    )
    $PermissionDifference = @(Compare-Object `
        -ReferenceObject $ExpectedPermissions `
        -DifferenceObject $ActualPermissions)
    if ($PermissionDifference.Count -ne 0) {
        throw "APK 权限集合错误。期望：$($ExpectedPermissions -join ', ')；实际：$($ActualPermissions -join ', ')"
    }

    $ManifestTree = (& $Aapt2 dump xmltree $Apk --file AndroidManifest.xml) -join "`n"
    Assert-ExitCode "编译后清单读取"
    Assert-Contains $ManifestTree "allowBackup(0x01010280)=false" "编译后清单未关闭系统备份"
    Assert-Contains $ManifestTree "fullBackupContent(0x010104eb)=false" "旧版系统备份未关闭"
    Assert-Contains $ManifestTree "dataExtractionRules(0x0101063e)=" "Android 12+ 数据迁移规则缺失"
    Assert-Contains $ManifestTree "usesCleartextTraffic(0x010104ec)=false" "编译后清单未禁用明文网络"
    Assert-Contains $ManifestTree "enableOnBackInvokedCallback(0x0101066c)=false" "系统返回键兼容设置缺失"
    Assert-Contains $ManifestTree "configChanges(0x0101001f)=0x00000fa0" "旋转时 WebView 状态保留配置缺失"

    $Entries = (& $Jar tf $Apk) -join "`n"
    Assert-ExitCode "APK 文件清单读取"
    foreach ($RequiredEntry in @(
        "classes.dex",
        "assets/index.html",
        "assets/app.js",
        "assets/core.js",
        "assets/text-import.js",
        "assets/edition.js",
        "assets/styles.css",
        "res/drawable/ic_launcher.xml",
        "res/drawable/ic_notification.xml",
        "res/xml/data_extraction_rules.xml"
    )) {
        Assert-Contains $Entries $RequiredEntry "APK 内容不完整"
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $Archive = [IO.Compression.ZipFile]::OpenRead($Apk)
    try {
        foreach ($AssetName in @("index.html", "app.js", "core.js", "text-import.js", "edition.js", "styles.css")) {
            $Entry = $Archive.GetEntry("assets/$AssetName")
            if ($null -eq $Entry) {
                throw "APK 缺少离线资源：assets/$AssetName"
            }
            $Stream = $Entry.Open()
            try {
                $Sha256 = [Security.Cryptography.SHA256]::Create()
                try {
                    $PackagedHash = [BitConverter]::ToString($Sha256.ComputeHash($Stream)).Replace("-", "")
                } finally {
                    $Sha256.Dispose()
                }
            } finally {
                $Stream.Dispose()
            }
            $SourcePath = "$StageRoot\assets\$AssetName"
            $SourceHash = (Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256).Hash
            if ($PackagedHash -ne $SourceHash) {
                throw "APK 中的 $AssetName 与最终源码哈希不一致"
            }
        }
    } finally {
        $Archive.Dispose()
    }

    $SourceManifest = Get-Content -LiteralPath "$StageRoot\AndroidManifest.xml" -Raw -Encoding UTF8
    Assert-Contains $SourceManifest 'android:allowBackup="false"' "必须关闭系统云备份"
    Assert-Contains $SourceManifest 'android:fullBackupContent="false"' "必须关闭旧版系统备份"
    Assert-Contains $SourceManifest 'android:dataExtractionRules="@xml/data_extraction_rules"' "必须关闭 Android 12+ 数据迁移"
    Assert-Contains $SourceManifest 'android:configChanges="keyboardHidden|orientation|screenLayout|screenSize|smallestScreenSize|uiMode"' "必须保留旋转时 WebView 状态"
    if ($AiImport) {
        Assert-Contains $SourceManifest 'android.permission.INTERNET' "可选文字识别需要 INTERNET 权限"
    } elseif ($SourceManifest.Contains('android.permission.INTERNET')) {
        throw "未启用文字识别的版本不应申请 INTERNET 权限"
    }
    $MainActivitySource = Get-Content -LiteralPath "${SubstDrive}\android\app\src\main\java\com\one68hours\app\MainActivity.java" -Raw -Encoding UTF8
    Assert-Contains $MainActivitySource "settings.setBuiltInZoomControls(true);" "WebView 必须启用双指缩放"
    Assert-Contains $MainActivitySource "settings.setDisplayZoomControls(false);" "WebView 不应显示屏幕缩放按钮"
    Assert-Contains $MainActivitySource "settings.setSupportZoom(true);" "WebView 必须允许页面缩放"
    Assert-Contains $MainActivitySource "settings.setBlockNetworkLoads(true);" "WebView 不应直接加载网络内容"
    $ExtractionRules = Get-Content -LiteralPath "${SubstDrive}\android\app\src\main\res\xml\data_extraction_rules.xml" -Raw -Encoding UTF8
    Assert-Contains $ExtractionRules "<cloud-backup" "云备份排除规则缺失"
    Assert-Contains $ExtractionRules "<device-transfer>" "设备迁移排除规则缺失"
    $AppScript = Get-Content -LiteralPath "${SubstDrive}\android\app\src\main\assets\app.js" -Raw -Encoding UTF8
    Assert-Contains $AppScript "window.receiveImportedData = receiveImportedData" "原生导入回调未接入"
    Assert-Contains $AppScript "window.handleAndroidBack = function" "系统返回键回调未接入"
    Assert-Contains $AppScript 'window.addEventListener("android-reminder-permission"' "通知权限结果未接入"
    Assert-Contains $AppScript "bridge.setSystemTheme" "系统栏主题桥接未接入"

    Write-Host "Android APK 验证通过：预期签名、版本、精确权限、对齐、入口和离线资源均正确。"
} finally {
    & subst.exe $SubstDrive /d | Out-Null
}
