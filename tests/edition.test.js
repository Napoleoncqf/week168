"use strict";
// 版本号统一：所有版本读同一个 editions/version.json，VersionCode 由版本号推出。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Edition } = require("./edition-helper.js");

test("every edition ships the single shared version", () => {
  const shared = Edition.loadVersion();
  assert.match(shared.versionName, /^\d+\.\d{1,2}\.\d{1,2}$/);
  const [major, minor, patch] = shared.versionName.split(".").map(Number);
  assert.equal(shared.versionCode, major * 10000 + minor * 100 + patch);
  Edition.listEditions().forEach((id) => {
    const edition = Edition.loadEdition(id);
    assert.equal(edition.versionName, shared.versionName, id);
    assert.equal(edition.versionCode, shared.versionCode, id);
    assert.equal(Edition.browserEdition(edition).version, shared.versionName, id);
  });
});

test("edition files never carry their own version numbers", () => {
  Edition.listEditions().forEach((id) => {
    const raw = JSON.parse(fs.readFileSync(path.join(Edition.ROOT, "editions", `${id}.json`), "utf8"));
    assert.equal("versionName" in raw || "versionCode" in raw, false, id);
  });
});
