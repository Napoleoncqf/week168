"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Edition, hasEdition } = require("./edition-helper.js");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

function run(name, test) {
  try {
    test();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}\n${error.stack}\n`);
    process.exitCode = 1;
  }
}

const styles = source("android/app/src/main/assets/styles.css");
const activity = source("android/app/src/main/java/com/one68hours/app/MainActivity.java");
const html = source("android/app/src/main/assets/index.html");
const app = source("android/app/src/main/assets/app.js");
const aiService = source("android/app/src/main/java/com/one68hours/app/AiImportService.java");
const profileStore = source("android/app/src/main/java/com/one68hours/app/AiProfileStore.java");
const manifest = source("android/app/src/main/AndroidManifest.xml");

run("timeline hands vertical boundary scrolling back to the page", () => {
  const block = styles.match(/\.timeline-scroll\s*\{([\s\S]*?)\}/);
  assert.ok(block, "timeline scroll styles are missing");
  assert.match(block[1], /overscroll-behavior-y:\s*auto\s*;/);
  assert.match(block[1], /overscroll-behavior-x:\s*contain\s*;/);
  assert.doesNotMatch(block[1], /overscroll-behavior:\s*contain\s*;/);
});

run("category bar fill is a block so its width is applied", () => {
  const block = styles.match(/\.bar-fill\s*\{([\s\S]*?)\}/);
  assert.ok(block, "bar fill styles are missing");
  assert.match(block[1], /display:\s*block\s*;/);
  assert.match(block[1], /width:\s*var\(--bar-width\)\s*;/);
});

run("heatmap quarters keep an explicit height inside button grid cells", () => {
  const block = styles.match(/\.heat-quarter\s*\{([\s\S]*?)\}/);
  assert.ok(block, "heat quarter styles are missing");
  assert.match(block[1], /min-height:\s*15px\s*;/);
  assert.match(styles, /\.heatmap\s*\{[\s\S]*?grid-auto-rows:\s*17px;/);
});

run("timeline shows untracked gaps as tappable 待补 blocks", () => {
  assert.match(app, /Core\.subtractIntervals\(dateStart, gapLimit, entries\)/);
  assert.match(app, /button\.className = "timeline-gap"/);
  assert.match(app, /case "fill-gap":/);
  assert.match(styles, /\.timeline-canvas\.range-select-mode \.timeline-gap\s*\{\s*pointer-events:\s*none;/);
});

run("new entry defaults to the open gap and keeps a thumb-reachable save", () => {
  assert.match(app, /const openGap = Core\.subtractIntervals\(dayStart, end, state\.entries\)\.pop\(\)/);
  assert.match(app, /categoriesByRecentUse\(\)\.map/);
  assert.match(html, /<div class="sheet-footer">\s*<button class="button primary full" type="button" data-action="save-entry">/);
  assert.equal((html.match(/data-action="save-entry"/g) || []).length, 1);
});

run("report hosts an edition extension and colors the donut by category", () => {
  assert.match(html, /<div id="editionReportSlot"><\/div>/);
  ["metricWorkStudy", "metricLife", "metricRest", "metricUntracked"]
    .forEach((id) => assert.match(html, new RegExp(`id="${id}"`)));
  if (hasEdition("personal")) {
    const markup = require("../editions/personal/report.js").markup;
    ["goalThesisPercent", "goalThesisMeter", "goalBoundaryMeter", "metricBoundary", "metricSleepDelta", "metricThesisDelta", "metricLowDelta"]
      .forEach((id) => assert.match(markup, new RegExp(`id="${id}"`)));
  }
  assert.match(app, /"--donut-gradient"/);
  assert.match(styles, /var\(--donut-gradient,/);
});

run("Android 15 applies and consumes system bar and cutout insets on a container", () => {
  assert.match(activity, /private FrameLayout webContainer\s*;/);
  assert.match(activity, /Api35Insets\.apply\(webContainer\)/);
  assert.match(activity, /WindowInsets\.Type\.systemBars\(\)\s*\|\s*[\s\S]*WindowInsets\.Type\.displayCutout\(\)/);
  assert.match(activity, /setInsets\(handledTypes, android\.graphics\.Insets\.NONE\)/);
  assert.doesNotMatch(activity, /static void apply\(WebView webView\)/);
});

run("automatic theme follows the Android system theme despite the light window theme", () => {
  assert.match(activity, /public boolean isSystemDark\(\)/);
  assert.match(activity, /emitStringEvent\("android-system-theme", isSystemDark\(\) \? "dark" : "light"\)/);
  assert.match(activity, /configureSystemBars\(isSystemDark\(\)\);/);
  assert.match(app, /bridge\.isSystemDark\(\) \? "dark" : "light"/);
  assert.match(app, /window\.addEventListener\("android-system-theme"/);
});

run("soft keyboard lifts the WebView so sheet fields and save stay visible", () => {
  assert.match(manifest, /android:windowSoftInputMode="adjustResize"/);
  assert.match(activity, /int imeType = android\.view\.WindowInsets\.Type\.ime\(\);/);
  assert.match(activity, /Math\.max\(bars\.bottom, ime\.bottom\)/);
});

run("personal app exposes optional native text import without changing its goals", () => {
  ["aiSheet", "aiDate", "aiText", "aiDraftList", "aiSaveButton", "aiEndpoint", "aiModel", "aiModelSelect", "aiKey", "aiProfileList", "aiImportProfile", "aiImportModel", "aiDeepThinking"]
    .forEach((id) => assert.match(html, new RegExp(`id=["']${id}["']`)));
  assert.match(html, /<script src="text-import\.js[^"]*"><\/script>/);
  assert.match(html, /id="aiProvider"/);
  assert.match(html, /DeepSeek（默认）/);
  assert.match(app, /DEEPSEEK_ENDPOINT = "https:\/\/api\.deepseek\.com\/chat\/completions"/);
  assert.match(profileStore, /DEFAULT_MODEL = "deepseek-flash"/);
  assert.match(profileStore, /migrateLegacy\(\)/);
  assert.match(activity, /public String getAiProfiles\(\)/);
  assert.match(aiService, /String testProfile\(String id\)/);
  assert.match(aiService, /fetchModels\(endpoint, profile\.token\)/);
  assert.match(aiService, /response_format/);
  assert.match(aiService, /input\.optBoolean\("deepThinking", false\) \? "enabled" : "disabled"/);
  assert.match(app, /window\.addEventListener\("android-ai-result"/);
  assert.match(activity, /settings\.setBlockNetworkLoads\(true\)/);
  assert.match(aiService, /HttpsURLConnection/);
  assert.match(profileStore, /AndroidKeyStore/);
  assert.match(manifest, /android\.permission\.INTERNET/);
});

// The shared sources are exported to the public repository, so personal
// categories and goals must live only in editions/personal*.
run("shared sources contain no personal categories or goals", () => {
  const core = source("android/app/src/main/assets/core.js");
  const privateTerms = /\u8bba\u6587|\x49\x73\x6f\x74\x6f\x70\x65|\x48\x43\x49|\u5237\u624b\u673a|\u4f4e\u8d28\u91cf\u6d88\u8017|60\x25\s*\u76ee\u6807|\u60c5\u7eea\u4f4e\u843d/;
  assert.doesNotMatch(`${html}
${app}
${core}
${styles}`, privateTerms);
});

run("editions without text recognition ship no network permission", () => {
  Edition.listEditions().forEach((id) => {
    const edition = Edition.loadEdition(id);
    const staged = Edition.renderManifest(edition);
    assert.ok(staged.includes(`package="${edition.packageName}"`), id);
    assert.match(staged, new RegExp(`android:targetSdkVersion="${edition.targetSdk}"`));
    assert.equal(/android\.permission\.INTERNET/.test(staged), edition.features.aiImport, id);
  });
});

run("the web build hides daily reminders and protects browser storage", () => {
  const reminder = html.match(/<section class="settings-group card"( data-native-only)?>\s*<div class="settings-row">\s*<div class="settings-title"><span class="settings-icon">◷<\/span>/);
  assert.ok(reminder && reminder[1], "reminder settings must be marked data-native-only");
  assert.match(html, /id="webStorageNote" data-web-only/);
  assert.match(app, /all\("\[data-native-only\]"\)/);
  assert.match(app, /storage\.persisted\(\)\.then\(\(granted\) => granted \|\| storage\.persist\(\)\)/);
});

const healthUi = source("android/app/src/main/assets/health-ui.js");
const doseScheduler = source("android/app/src/main/java/com/one68hours/app/DoseReminderScheduler.java");
const notifications = source("android/app/src/main/java/com/one68hours/app/NotificationHelper.java");

run("health tracking is opt-in and keeps the five-item bottom navigation", () => {
  assert.equal((html.match(/data-nav="/g) || []).length, 5);
  assert.doesNotMatch(html, /data-nav="health"/);
  assert.match(html, /id="healthEnabled"(?![^>]*checked)/);
  assert.match(html, /id="healthGlance"[^>]*hidden/);
  const scripts = Array.from(html.matchAll(/<script src="([^"?]+)/g)).map((match) => match[1]);
  assert.deepEqual(scripts, ["edition.js", "core.js", "text-import.js", "health-core.js", "health-ui.js", "app.js"]);
  assert.match(html, /<section class="settings-group card" data-feature="health">/);
});

run("health UI never sends data out or recommends doses", () => {
  assert.doesNotMatch(healthUi, /fetch\(|XMLHttpRequest|sendBeacon|WebSocket/);
  assert.doesNotMatch(`${html}\n${healthUi}`, /建议剂量|剂量建议为|自动计算剂量|加量到|减量到/);
  assert.match(html, /不推荐剂量/);
  assert.doesNotMatch(html, /不计算剂量/);
});

run("health page leads with the next-dose card, then tiles, today and the site map", () => {
  const page = html.slice(html.indexOf('id="view-health"'), html.indexOf("</main>"));
  const order = ["doseCard", "lastDoseTile", "weightTile", "healthTodayList", "levelBody", "siteMap", "weightChart", "injectionList"]
    .map((id) => page.indexOf(`id="${id}"`));
  order.forEach((index) => assert.ok(index > 0));
  assert.deepEqual(order, order.slice().sort((a, b) => a - b));
  assert.doesNotMatch(page, /照顾好身体的节奏/);
  assert.match(page, /<h1 id="healthTitle">/);
});

run("site map is inline SVG and the level estimate is labelled as an estimate", () => {
  assert.doesNotMatch(`${html}\n${healthUi}`, /<img|\.png|\.jpg|url\(http/i);
  assert.match(healthUi, /class="body-map" viewBox=/);
  ["arm-left", "arm-right", "abdomen-left", "abdomen-right", "thigh-left", "thigh-right"].forEach((id) => {
    assert.match(healthUi, new RegExp(`"${id}": \\[\\d+, \\d+\\]`));
  });
  assert.match(html, /<section class="card level-card"[\s\S]*?估算值，仅供参考，不构成医疗建议。[\s\S]*?<\/section>/);
  assert.match(healthUi, /H\.levelEstimate\(state, new Date\(\)\)/);
});

run("health cards stay within a 360dp screen", () => {
  const small = styles.slice(styles.lastIndexOf("@media (max-width: 390px)"));
  assert.match(small, /\.site-map\s*\{[^}]*grid-template-columns:\s*108px/);
  assert.match(small, /\.dose-ring\s*\{[^}]*width:\s*102px/);
  assert.match(styles, /\.health-tiles\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
});

run("dose reminders use their own alarm slot and a private notification", () => {
  assert.match(doseScheduler, /REQUEST_CODE = 169/);
  assert.match(doseScheduler, /PREFS = "dose_reminder"/);
  assert.match(notifications, /DOSE_CHANNEL_ID = "dose_reminder"/);
  assert.match(notifications, /setPublicVersion\(publicVersion\)/);
});

run("JS dialogs are native and the WebView repaints after returning to the app", () => {
  assert.match(activity, /new OfflineChromeClient\(\)/);
  assert.match(activity, /public boolean onJsAlert\(/);
  assert.match(activity, /public boolean onJsConfirm\(/);
  assert.match(activity, /setOnCancelListener[\s\S]*?result\.cancel\(\)/);
  const resume = activity.slice(activity.indexOf("protected void onResume()"), activity.indexOf("protected void onPause()"));
  assert.match(resume, /webView\.onResume\(\);[\s\S]*?webView\.invalidate\(\);/);
});
