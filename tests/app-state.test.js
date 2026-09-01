"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Core = require("../android/app/src/main/assets/core.js");

const APP_SOURCE = fs.readFileSync(
  path.join(__dirname, "../android/app/src/main/assets/app.js"),
  "utf8"
);
const STORAGE_KEY = "time168.state.v1";
const RECOVERY_KEY = "time168.recovery.v1";

function loadApp(initial) {
  const values = new Map(Object.entries(initial || {}));
  const localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
  };
  const document = {
    readyState: "loading",
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const context = {
    console,
    document,
    localStorage,
    navigator: {},
    Blob,
    URL,
    setTimeout,
    clearTimeout,
    requestAnimationFrame(callback) { return setTimeout(callback, 0); },
  };
  context.window = context;
  context.Time168Core = Core;
  vm.runInNewContext(APP_SOURCE, context, { filename: "app.js" });
  return { api: context.__Time168App, values };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function entry(overrides) {
  return {
    id: "e-valid",
    start: "2026-08-30T01:00:00.000Z",
    end: "2026-08-30T02:00:00.000Z",
    categoryId: "work",
    content: "整理计划",
    location: "家",
    energy: 3,
    mood: 4,
    note: "",
    createdAt: "2026-08-30T02:00:00.000Z",
    updatedAt: "2026-08-30T02:00:00.000Z",
    ...(overrides || {}),
  };
}

function backupWithEntry() {
  const loaded = loadApp();
  const backup = plain(loaded.api.makeBackup());
  backup.entries = [entry()];
  return { api: loaded.api, backup };
}

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

test("a valid current backup imports without normalization loss", () => {
  const { api, backup } = backupWithEntry();
  const result = plain(api.validateBackup(backup));
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.deepEqual(result.state.entries[0], entry());
});

test("public defaults use ten neutral everyday categories", () => {
  const state = plain(loadApp().api.getState());
  assert.deepEqual(state.categories.map((item) => item.id), [
    "sleep", "work", "study", "commute", "routine",
    "exercise", "rest", "social", "leisure", "other",
  ]);
  assert.deepEqual(state.categories.map((item) => item.name), [
    "睡眠", "工作", "学习", "通勤", "生活事务",
    "运动", "休息", "社交", "娱乐", "其他",
  ]);
  assert.equal(new Set(state.categories.map((item) => item.id)).size, 10);
  assert.ok(state.categories.every((item) => item.custom === false));
});

test("new backups use week168 and the legacy app marker remains importable", () => {
  const loaded = loadApp();
  const backup = plain(loaded.api.makeBackup());
  assert.equal(backup.app, "week168");
  backup.app = "168hours";
  assert.equal(plain(loaded.api.validateBackup(backup)).ok, true);
});

test("zeroed legacy rating fields remain valid JSON data", () => {
  const { api, backup } = backupWithEntry();
  backup.entries = [entry({ energy: 0, mood: 0 })];
  const result = plain(api.validateBackup(backup));
  assert.equal(result.ok, true);
  assert.equal(result.state.entries[0].energy, 0);
  assert.equal(result.state.entries[0].mood, 0);
});

test("strict import rejects values that cleanEntry would silently coerce", () => {
  const mutations = [
    (item) => { item.start = null; },
    (item) => { delete item.id; },
    (item) => { item.start = "2026-08-30T01:00:30.000Z"; },
    (item) => { item.energy = "3"; },
    (item) => { item.content = "x".repeat(161); },
  ];
  mutations.forEach((mutate) => {
    const { api, backup } = backupWithEntry();
    mutate(backup.entries[0]);
    assert.equal(plain(api.validateBackup(backup)).ok, false);
  });
});

test("strict import rejects altered system flags and fake default categories", () => {
  const first = backupWithEntry();
  first.backup.categories.find((item) => item.id === "sleep").sleep = false;
  assert.equal(plain(first.api.validateBackup(first.backup)).ok, false);

  const second = backupWithEntry();
  second.backup.categories.push({
    id: "unknown-system",
    name: "未知系统类",
    color: "#123456",
    custom: false,
    sleep: false,
    lowQuality: false,
  });
  assert.equal(plain(second.api.validateBackup(second.backup)).ok, false);
});

test("strict import rejects overlapping records", () => {
  const { api, backup } = backupWithEntry();
  backup.entries.push(entry({
    id: "e-overlap",
    start: "2026-08-30T01:45:00.000Z",
    end: "2026-08-30T02:15:00.000Z",
  }));
  assert.equal(plain(api.validateBackup(backup)).ok, false);
});

test("invalid JSON is preserved and never overwritten during load", () => {
  const raw = "{damaged-json";
  const loaded = loadApp({ [STORAGE_KEY]: raw });
  assert.equal(loaded.values.get(STORAGE_KEY), raw);
  assert.equal(loaded.values.get(RECOVERY_KEY), raw);
  assert.equal(plain(loaded.api.getState()).entries.length, 0);
});

test("unknown local versions are preserved for recovery", () => {
  const raw = JSON.stringify({ version: 99, entries: [], categories: [], settings: {} });
  const loaded = loadApp({ [STORAGE_KEY]: raw });
  assert.equal(loaded.values.get(STORAGE_KEY), raw);
  assert.equal(loaded.values.get(RECOVERY_KEY), raw);
});

test("same-count local coercion still creates a recovery copy", () => {
  const seed = loadApp();
  const source = plain(seed.api.getState());
  source.entries = [entry({ energy: 999 })];
  const raw = JSON.stringify(source);
  const loaded = loadApp({ [STORAGE_KEY]: raw });
  assert.equal(loaded.values.get(STORAGE_KEY), raw);
  assert.equal(loaded.values.get(RECOVERY_KEY), raw);
  assert.equal(plain(loaded.api.getState()).entries[0].energy, 5);
});

test("canonical local state loads without a false recovery warning", () => {
  const seed = loadApp();
  const source = plain(seed.api.getState());
  source.entries = [entry()];
  const canonical = plain(seed.api.normalizeState(source));
  const raw = JSON.stringify(canonical);
  const loaded = loadApp({ [STORAGE_KEY]: raw });
  assert.equal(loaded.values.get(STORAGE_KEY), raw);
  assert.equal(loaded.values.has(RECOVERY_KEY), false);
  assert.equal(plain(loaded.api.getState()).entries.length, 1);
});
