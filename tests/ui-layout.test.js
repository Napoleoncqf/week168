"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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
const app = source("android/app/src/main/assets/app.js");
const core = source("android/app/src/main/assets/core.js");
const html = source("android/app/src/main/assets/index.html");
const activity = source("android/app/src/main/java/io/github/napoleoncqf/week168/MainActivity.java");

run("public UI and reports contain only generic time categories", () => {
  const publicText = `${html}\n${app}\n${core}`;
  const privateTerms = /\u8bba\u6587|\x49\x73\x6f\x74\x6f\x70\x65|\x48\x43\x49|\u5237\u624b\u673a|\u4f4e\u8d28\u91cf\u6d88\u8017|60\x25\s*\u76ee\u6807|\u60c5\u7eea\u4f4e\u843d/;
  assert.doesNotMatch(publicText, privateTerms);
  assert.match(html, /<title>Week 168<\/title>/);
  assert.match(html, /<strong>Week 168<\/strong>/);
  assert.match(html, /<span>v1\.0\.0<\/span>/);
  ["metricWorkStudy", "metricLife", "metricRest", "metricUntracked"].forEach((id) => {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  });
  assert.match(app, /工作\/学习：/);
  assert.match(app, /生活事务：/);
  assert.match(app, /休息娱乐：/);
});

run("entry sheet omits rating controls while the data schema stays compatible", () => {
  assert.doesNotMatch(html, /energyRating|moodRating|能量评分|心情评分/);
  assert.doesNotMatch(app, /energyRating|moodRating|renderRatings|set-rating/);
  assert.match(core, /energy:\s*Math\.min\(5,/);
  assert.match(core, /mood:\s*Math\.min\(5,/);
});

run("timeline hands vertical boundary scrolling back to the page", () => {
  const block = styles.match(/\.timeline-scroll\s*\{([\s\S]*?)\}/);
  assert.ok(block, "timeline scroll styles are missing");
  assert.match(block[1], /overscroll-behavior-y:\s*auto\s*;/);
  assert.match(block[1], /overscroll-behavior-x:\s*contain\s*;/);
  assert.doesNotMatch(block[1], /overscroll-behavior:\s*contain\s*;/);
});

run("Android 15 applies and consumes system bar and cutout insets on a container", () => {
  assert.match(activity, /private FrameLayout webContainer\s*;/);
  assert.match(activity, /Api35Insets\.apply\(webContainer\)/);
  assert.match(activity, /WindowInsets\.Type\.systemBars\(\)\s*\|\s*[\s\S]*WindowInsets\.Type\.displayCutout\(\)/);
  assert.match(activity, /setInsets\(handledTypes, android\.graphics\.Insets\.NONE\)/);
  assert.doesNotMatch(activity, /static void apply\(WebView webView\)/);
});
