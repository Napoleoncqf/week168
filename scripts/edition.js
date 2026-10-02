"use strict";
// 版本（edition）配置的唯一读取入口：构建脚本、PWA 打包和测试都从这里取同一份配置。
// 源码以个人版包名 com.one68hours.app 为准，其他版本在暂存目录里改写包名。

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SOURCE = path.join(ROOT, "android/app/src/main");
const CANONICAL_PACKAGE = "com.one68hours.app";
const INTERNET_PERMISSION = '    <uses-permission android:name="android.permission.INTERNET" />\n';

function fail(message) {
  throw new Error(`版本配置错误：${message}`);
}

function listEditions() {
  return fs.readdirSync(path.join(ROOT, "editions"))
    .filter((name) => name.endsWith(".json") && name !== "version.json")
    .map((name) => name.slice(0, -5))
    .sort();
}

// 所有版本共用一个版本号，只写在 editions/version.json；VersionCode 由它推出
// （1.2.0 → 10200），不再单独维护，避免两个数字或两个版本对不上。
function loadVersion() {
  const file = path.join(ROOT, "editions", "version.json");
  if (!fs.existsSync(file)) fail("找不到 editions/version.json");
  const { version } = JSON.parse(fs.readFileSync(file, "utf8"));
  const match = /^(\d+)\.(\d{1,2})\.(\d{1,2})$/.exec(String(version || ""));
  if (!match) fail("editions/version.json 的 version 须为 x.y.z，次版本和修订号不超过 99");
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major < 1) fail("主版本号至少为 1");
  return { versionName: version, versionCode: major * 10000 + minor * 100 + patch };
}

function loadEdition(id) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(String(id || ""))) fail(`无效的版本名 ${id}`);
  const file = path.join(ROOT, "editions", `${id}.json`);
  if (!fs.existsSync(file)) fail(`找不到 editions/${id}.json`);
  const edition = JSON.parse(fs.readFileSync(file, "utf8"));
  if (edition.id !== id) fail(`${id}.json 的 id 不一致`);
  if ("versionName" in edition || "versionCode" in edition) fail(`${id}.json 不应再写版本号，统一改 editions/version.json`);
  Object.assign(edition, loadVersion());
  for (const key of ["appName", "launcherName", "packageName", "platform", "releaseApk"]) {
    if (typeof edition[key] !== "string" || !edition[key].trim()) fail(`${id} 缺少 ${key}`);
  }
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(edition.packageName)) fail(`${id} 的包名无效`);
  if (!Number.isInteger(edition.targetSdk) || edition.targetSdk < 26) fail(`${id} 的 targetSdk 无效`);
  if (edition.reportExtension != null) {
    if (!/^[a-z0-9-]+\/[a-z0-9-]+\.js$/.test(edition.reportExtension)
        || !fs.existsSync(path.join(ROOT, "editions", edition.reportExtension))) fail(`${id} 的 reportExtension 无效`);
  }
  const features = edition.features || {};
  if (typeof features.aiImport !== "boolean" || typeof features.ratings !== "boolean") fail(`${id} 的 features 不完整`);
  const backup = edition.backup || {};
  if (!backup.app || !Array.isArray(backup.accept) || !backup.accept.includes(backup.app)
      || !backup.recoveryApp || !backup.filePrefix || !backup.nativeFilePrefix) fail(`${id} 的 backup 不完整`);
  const ids = new Set();
  if (!Array.isArray(edition.categories) || !edition.categories.length) fail(`${id} 没有默认分类`);
  edition.categories.forEach((category) => {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(category.id || "") || ids.has(category.id)) fail(`${id} 分类 ID 无效或重复`);
    if (!category.name || !/^#[0-9a-f]{6}$/i.test(category.color || "")) fail(`${id} 分类 ${category.id} 缺少名称或颜色`);
    ids.add(category.id);
  });
  if (!ids.has("other")) fail(`${id} 需要保留 other 分类`);
  return edition;
}

// 页面只拿到展示和行为所需的字段；签名、包名等构建信息不进入前端。
function browserEdition(edition) {
  return {
    id: edition.id,
    appName: edition.appName,
    version: edition.versionName,
    features: { ...edition.features },
    backup: {
      app: edition.backup.app,
      accept: [...edition.backup.accept],
      recoveryApp: edition.backup.recoveryApp,
      filePrefix: edition.backup.filePrefix,
    },
    text: { ...(edition.text || {}) },
    categories: edition.categories.map((category) => ({ ...category })),
  };
}

// 生成的 edition.js = 版本配置 + 可选的周报扩展（editions/<id>/report.js）。
function editionScript(edition) {
  const extension = edition.reportExtension
    ? `\n${fs.readFileSync(path.join(ROOT, "editions", edition.reportExtension), "utf8")}`
    : "";
  return `"use strict";\n// 由 scripts/edition.js 根据 editions/${edition.id}.json 生成，请勿手改。\n`
    + `window.Time168Edition = ${JSON.stringify(browserEdition(edition), null, 2)};\n${extension}`;
}

function javaString(value) {
  return JSON.stringify(String(value));
}

function editionJava(edition) {
  return `package ${edition.packageName};\n\n`
    + `/** 由 scripts/edition.js 根据 editions/${edition.id}.json 生成，请勿手改。 */\n`
    + "final class Edition {\n"
    + `    static final String ID = ${javaString(edition.id)};\n`
    + `    static final boolean AI_IMPORT = ${edition.features.aiImport};\n`
    + `    static final String BACKUP_FILE_PREFIX = ${javaString(edition.backup.nativeFilePrefix)};\n\n`
    + "    private Edition() {}\n"
    + "}\n";
}

// 不用 fs.cpSync：Node 24 在 Windows 中文路径下会直接崩溃（0xC0000409）。
function copyTree(from, to, transform) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const source = path.join(from, name);
    const target = path.join(to, name);
    if (fs.statSync(source).isDirectory()) copyTree(source, target, transform);
    else if (transform) fs.writeFileSync(target, transform(source, fs.readFileSync(source, "utf8")));
    else fs.copyFileSync(source, target);
  }
}

function stageAssets(edition, outDir) {
  copyTree(path.join(SOURCE, "assets"), outDir);
  fs.writeFileSync(path.join(outDir, "edition.js"), editionScript(edition));
}

function renderManifest(edition) {
  let manifest = fs.readFileSync(path.join(SOURCE, "AndroidManifest.xml"), "utf8").replace(/\r\n/g, "\n");
  if (!manifest.includes(INTERNET_PERMISSION)) fail("清单中找不到 INTERNET 权限行");
  if (!edition.features.aiImport) manifest = manifest.replace(INTERNET_PERMISSION, "");
  manifest = manifest
    .replace(`package="${CANONICAL_PACKAGE}"`, `package="${edition.packageName}"`)
    .replace(/android:targetSdkVersion="\d+"/, `android:targetSdkVersion="${edition.targetSdk}"`);
  return manifest;
}

// 输出 build.ps1 需要的完整 Android 源码树：assets、res、清单和改写包名后的 Java。
function stageAndroid(edition, outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  stageAssets(edition, path.join(outDir, "assets"));
  fs.writeFileSync(path.join(outDir, "AndroidManifest.xml"), renderManifest(edition));
  copyTree(path.join(SOURCE, "res"), path.join(outDir, "res"), (file, text) => (
    path.basename(file) === "strings.xml"
      ? text.replace(/<string name="app_name">[^<]*<\/string>/, `<string name="app_name">${edition.launcherName}</string>`)
      : text
  ));
  const javaRoot = path.join(outDir, "java", ...edition.packageName.split("."));
  const canonicalRoot = path.join(SOURCE, "java", ...CANONICAL_PACKAGE.split("."));
  copyTree(canonicalRoot, javaRoot, (file, text) => text.split(CANONICAL_PACKAGE).join(edition.packageName));
  fs.writeFileSync(path.join(javaRoot, "Edition.java"), editionJava(edition));
}

module.exports = {
  ROOT, SOURCE, CANONICAL_PACKAGE,
  listEditions, loadEdition, loadVersion, browserEdition, editionScript, editionJava, copyTree,
  renderManifest, stageAssets, stageAndroid,
};

// 命令行：node scripts/edition.js stage <edition> <输出目录>
//        node scripts/edition.js get <edition> <字段>
if (require.main === module) {
  const [command, id, arg] = process.argv.slice(2);
  try {
    const edition = loadEdition(id);
    if (command === "stage" && arg) {
      stageAndroid(edition, path.resolve(arg));
    } else if (command === "get" && arg) {
      const value = arg.split(".").reduce((item, key) => (item == null ? item : item[key]), edition);
      if (value === undefined) fail(`${id} 没有字段 ${arg}`);
      process.stdout.write(typeof value === "object" ? JSON.stringify(value) : String(value));
    } else {
      throw new Error("用法：node scripts/edition.js stage <edition> <outDir> | get <edition> <field>");
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
