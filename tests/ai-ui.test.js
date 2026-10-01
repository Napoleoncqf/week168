"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Core = require("../android/app/src/main/assets/core.js");
const TextImport = require("../android/app/src/main/assets/text-import.js");
const { PRIMARY_EDITION, installEdition } = require("./edition-helper.js");

const assets = path.join(__dirname, "../android/app/src/main/assets");
const html = fs.readFileSync(path.join(assets, "index.html"), "utf8");
const source = fs.readFileSync(path.join(assets, "app.js"), "utf8");
const endpoint = "https://api.deepseek.com/chat/completions";
const profile = { id: "saved", name: "我的 DeepSeek", endpoint, model: "deepseek-flash", hasKey: true, models: [] };

// Exercise the real UI functions with a minimal DOM and native-bridge mock.
// Layout, native dialogs, encryption and network transport are outside this fixture.
function load(initialProfiles = [profile]) {
  let document;
  function element(id = "") {
    const classes = new Set();
    return {
      id, value: "", textContent: "", innerHTML: "", hidden: false,
      disabled: false, checked: false, open: false, dataset: {}, children: [],
      style: { setProperty() {} },
      classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      },
      setAttribute() {}, removeAttribute() {}, addEventListener() {},
      appendChild(child) { this.children.push(child); },
      replaceChildren() { this.children = []; this.innerHTML = ""; },
      focus() { document.activeElement = this; },
      scrollIntoView() {},
      querySelector() { return null; },
    };
  }
  const elements = new Map(Array.from(html.matchAll(/\bid="([^"]+)"/g), (match) => [match[1], element(match[1])]));
  document = {
    readyState: "loading", activeElement: null, body: element("body"),
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    createElement: () => element(), getElementById: (id) => elements.get(id) || null,
  };
  ["entrySheet", "aiSheet", "categorySheet"].forEach((id) => elements.get(id).classList.add("hidden"));
  const profiles = structuredClone(initialProfiles);
  let activeId = profiles[0]?.id || "";
  const calls = { save: [], test: [], analyze: [], remove: [] };
  const bridge = {
    getAiProfiles: () => JSON.stringify({ ok: true, profiles, activeId }),
    saveAiProfile(id, name, url, model, key) {
      calls.save.push({ id, name, endpoint: url, model, key });
      if (!id && !key) return JSON.stringify({ ok: false, message: "请输入 API Key" });
      const saved = profiles.find((item) => item.id === id);
      if (saved) Object.assign(saved, { name, endpoint: url, model });
      else profiles.push({ id: "new-profile", name, endpoint: url, model, hasKey: true, models: [] });
      if (!activeId) activeId = "new-profile";
      return JSON.stringify({ ok: true, id: saved ? id : "new-profile" });
    },
    activateAiProfile(id) { activeId = id; return JSON.stringify({ ok: true }); },
    deleteAiProfile(id) {
      calls.remove.push(id);
      const index = profiles.findIndex((item) => item.id === id);
      if (index >= 0) profiles.splice(index, 1);
      if (activeId === id) activeId = profiles[0]?.id || "";
      return JSON.stringify({ ok: true });
    },
    testAiProfile: (id) => calls.test.push(id),
    analyzeDayText: (raw) => calls.analyze.push(JSON.parse(raw)),
  };
  const storage = new Map();
  const context = {
    console, document, navigator: {}, URL, Blob, performance,
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    requestAnimationFrame: (callback) => callback(), confirm: () => true,
    Time168Core: Core, Time168TextImport: TextImport, AndroidBridge: bridge,
  };
  context.window = context;
  installEdition(context, PRIMARY_EDITION);
  const marker = "  window.__Time168App = {";
  assert.ok(source.includes(marker));
  const exposed = `  window.__AiUiTest = {
    ui, renderAiSettings, newAiProfile, editAiProfile, closeAiProfileEditor,
    saveAiProfile, testAiProfile, receiveAiProfileTest, renderAiImportProfiles,
    onAiImportModelChange, updateAiRecognitionSummary, analyzeDayText,
    openAiImport, closeAiImport, updateFloatingAddVisibility, handleAction, storeAiDraftText
  };\n`;
  vm.runInNewContext(source.replace(marker, exposed + marker), context, { filename: "app.js" });
  return { api: context.__AiUiTest, app: context.__Time168App, context, bridge, profiles, calls, storage, get: (id) => elements.get(id) };
}

test("saved profiles start as summaries; editing and cancel do not change saved data", () => {
  const { api, get, profiles } = load();
  api.renderAiSettings();
  assert.equal(get("aiProfileEditor").hidden, true);
  assert.match(get("aiProfileList").innerHTML, /管理/);
  assert.doesNotMatch(get("aiProfileList").innerHTML, /data-action="test-ai-profile"|data-action="delete-ai-profile"/);
  api.editAiProfile("saved");
  assert.equal(get("aiProfileEditor").hidden, false);
  assert.equal(get("aiModelSelect").value, "deepseek-flash");
  assert.equal(get("aiKey").value, "");
  assert.match(get("aiKey").placeholder, /留空保留/);
  get("aiKey").value = "not-a-real-key";
  get("aiProfileName").value = "unsaved edit";
  api.closeAiProfileEditor();
  assert.equal(get("aiProfileEditor").hidden, true);
  assert.equal(get("aiKey").value, "");
  assert.equal(profiles[0].name, profile.name);
});

test("a failed save stays open; successful new configuration collapses to the list", () => {
  const { api, get, calls, profiles } = load([]);
  api.renderAiSettings();
  api.newAiProfile();
  assert.equal(get("aiProfileEditor").hidden, false);
  assert.equal(get("aiTestProfileButton").disabled, true);
  api.saveAiProfile();
  assert.equal(get("aiProfileEditor").hidden, false);
  get("aiKey").value = "not-a-real-key";
  api.saveAiProfile();
  assert.equal(get("aiProfileEditor").hidden, true);
  assert.equal(get("aiKey").value, "");
  assert.equal(profiles.length, 1);
  assert.equal(calls.save.at(-1).model, "deepseek-flash");
  assert.match(get("aiProfileList").innerHTML, /DeepSeek Flash/);
  assert.doesNotMatch(get("aiProfileList").innerHTML, /not-a-real-key/);
});

test("unsaved model changes cannot test the previous model; save preserves a blank key", () => {
  const { api, get, calls, profiles } = load();
  api.renderAiSettings();
  api.editAiProfile("saved");
  get("aiModelSelect").value = "deepseek-v4-pro";
  api.testAiProfile();
  assert.equal(calls.test.length, 0);
  api.saveAiProfile();
  assert.equal(calls.save[0].key, "");
  assert.equal(profiles[0].model, "deepseek-v4-pro");
  api.editAiProfile("saved");
  api.testAiProfile();
  assert.deepEqual(calls.test, ["saved"]);
});

test("management actions use the edited profile; deletion still requires confirmation", () => {
  const second = { ...profile, id: "second", name: "备用配置" };
  const { api, get, calls, profiles, context } = load([profile, second]);
  api.renderAiSettings();
  api.editAiProfile("second");
  assert.equal(get("aiActivateProfileButton").hidden, false);
  api.handleAction("activate-ai-profile", get("aiActivateProfileButton"));
  assert.equal(api.ui.aiActiveProfileId, "second");
  assert.equal(get("aiActivateProfileButton").hidden, true);
  context.confirm = () => false;
  api.handleAction("delete-ai-profile", get("aiDeleteProfileButton"));
  assert.equal(calls.remove.length, 0);
  assert.equal(profiles.length, 2);
  context.confirm = () => true;
  api.handleAction("delete-ai-profile", get("aiDeleteProfileButton"));
  assert.deepEqual(calls.remove, ["second"]);
  assert.equal(profiles[0].id, "saved");
  assert.equal(get("aiProfileEditor").hidden, true);
});

test("async test completion and read failure preserve edits already being typed", () => {
  const { api, get, bridge } = load();
  api.renderAiSettings();
  api.editAiProfile("saved");
  api.testAiProfile();
  get("aiProfileName").value = "pending name";
  get("aiKey").value = "pending-key";
  api.receiveAiProfileTest(JSON.stringify({ requestId: "saved", result: { ok: true, message: "测试完成" } }));
  assert.equal(get("aiProfileName").value, "pending name");
  assert.equal(get("aiKey").value, "pending-key");
  assert.equal(get("aiProfileEditor").hidden, false);
  assert.equal(get("aiSettingsStatus").textContent, "测试完成");
  bridge.getAiProfiles = () => JSON.stringify({ ok: false, message: "读取失败" });
  api.renderAiSettings();
  assert.equal(get("aiProfileName").value, "pending name");
  assert.equal(get("aiKey").value, "pending-key");
  assert.equal(get("aiProfileEditor").hidden, false);
});

test("recognition defaults are collapsed and readable; changed settings reach the native request", () => {
  const { api, get, calls } = load();
  api.openAiImport();
  assert.equal(get("aiRecognitionSettings").open, false);
  assert.equal(get("aiRecognitionSummary").textContent, "DeepSeek Flash · 快速");
  assert.doesNotMatch(get("aiImportModel").innerHTML, /deepseek-flash · deepseek-flash/);
  get("aiImportModel").value = "deepseek-v4-pro";
  api.onAiImportModelChange();
  get("aiDeepThinking").checked = true;
  api.updateAiRecognitionSummary();
  assert.equal(get("aiRecognitionSummary").textContent, "DeepSeek V4 Pro · 深度");
  get("aiDate").value = "2026-09-21";
  get("aiText").value = "09:00 到 10:00 工作";
  api.analyzeDayText();
  assert.equal(calls.analyze.length, 1);
  assert.equal(calls.analyze[0].profileId, "saved");
  assert.equal(calls.analyze[0].model, "deepseek-v4-pro");
  assert.equal(calls.analyze[0].deepThinking, true);
  assert.equal(get("aiText").disabled, true);
  api.closeAiImport();
  assert.equal(get("aiText").disabled, false);
});

test("no saved profile keeps recognition disabled and exposes the setup path", () => {
  const { api, get, calls } = load([]);
  api.openAiImport();
  assert.equal(get("aiAnalyzeButton").disabled, true);
  assert.equal(get("aiSetupHint").hidden, false);
  assert.equal(get("aiRecognitionSummary").textContent, "请先添加 API 配置");
  api.analyzeDayText();
  assert.equal(calls.analyze.length, 0);
});

test("floating add is contextual and Android back closes the profile editor first", () => {
  const { api, get, context } = load();
  for (const view of ["week", "report", "history", "settings"]) {
    api.ui.view = view;
    api.ui.quickPanelVisible = false;
    api.updateFloatingAddVisibility();
    assert.equal(get("floatingAdd").hidden, true);
  }
  api.ui.view = "today";
  api.ui.quickPanelVisible = true;
  api.updateFloatingAddVisibility();
  assert.equal(get("floatingAdd").hidden, true);
  api.ui.quickPanelVisible = false;
  api.updateFloatingAddVisibility();
  assert.equal(get("floatingAdd").hidden, false);
  api.ui.view = "settings";
  api.renderAiSettings();
  api.editAiProfile("saved");
  assert.equal(context.handleAndroidBack(), true);
  assert.equal(api.ui.view, "settings");
  assert.equal(get("aiProfileEditor").hidden, true);
});

test("unsent day text is restored after the sheet or app was closed", () => {
  const { api, get, storage } = load();
  get("aiDate").value = "2026-09-01";
  get("aiText").value = "9点到12点写报告";
  api.storeAiDraftText();
  assert.ok(storage.has("time168.aiDraft.v1"));
  get("aiText").value = "";
  api.openAiImport();
  assert.equal(get("aiText").value, "9点到12点写报告");
  assert.equal(get("aiDate").value, "2026-09-01");
  get("aiText").value = "";
  api.storeAiDraftText();
  assert.equal(storage.has("time168.aiDraft.v1"), false);
});
