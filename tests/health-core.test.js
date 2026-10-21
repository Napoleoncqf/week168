"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const path = require("node:path");
const Core = require("../android/app/src/main/assets/core.js");
const Health = require("../android/app/src/main/assets/health-core.js");

function run(name, test) {
  try {
    test();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}\n${error.stack}\n`);
    process.exitCode = 1;
  }
}

function memoryStorage(initial) {
  const values = new Map(Object.entries(initial || {}));
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
  };
}

function localIso(dateKey, time) {
  return Core.fromLocalDateKey(dateKey, Core.parseTime(time)).toISOString();
}

function injection(overrides) {
  const occurredAt = localIso("2026-10-15", "09:00");
  return {
    id: "inj-a",
    occurredAt,
    name: "示例药物",
    doseValue: 2.5,
    doseUnit: "mg",
    site: "abdomen-left",
    note: "",
    createdAt: occurredAt,
    updatedAt: occurredAt,
    ...(overrides || {}),
  };
}

function weight(date, kg, overrides) {
  return {
    id: `w-${date}`,
    date,
    kg,
    note: "",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...(overrides || {}),
  };
}

function plan(overrides) {
  return {
    name: "示例药物",
    doseValue: 2.5,
    doseUnit: "mg",
    intervalDays: 7,
    startDate: "2026-10-15",
    reminderEnabled: false,
    reminderTime: "09:00",
    ...(overrides || {}),
  };
}

function state(overrides) {
  return Health.normalizeHealth({
    ...Health.defaultHealth(),
    enabled: true,
    updatedAt: "2026-10-19T00:00:00.000Z",
    ...(overrides || {}),
  });
}

run("health data uses its own storage key and starts disabled", () => {
  assert.equal(Health.STORAGE_KEY, "time168.health.v1");
  assert.notEqual(Health.STORAGE_KEY, "time168.state.v1");
  const fresh = Health.defaultHealth();
  assert.equal(fresh.enabled, false);
  assert.equal(fresh.plan, null);
  assert.deepEqual(fresh.injections, []);
  assert.deepEqual(fresh.weights, []);
});

run("canonical state round-trips through normalize unchanged", () => {
  const value = state({ plan: plan(), injections: [injection()], weights: [weight("2026-10-18", 86.9)] });
  assert.equal(Health.isCanonicalHealth(JSON.parse(JSON.stringify(value))), true);
});

run("normalize drops invalid records instead of coercing them", () => {
  const value = Health.normalizeHealth({
    version: 1,
    enabled: true,
    plan: plan({ intervalDays: 0 }),
    injections: [
      injection(),
      injection({ id: "bad id with spaces" }),
      injection({ id: "inj-b", occurredAt: "not-a-date" }),
    ],
    weights: [weight("2026-10-18", 86.9), weight("2026-10-19", 5), weight("2026-02-30", 80)],
  });
  assert.equal(value.plan, null);
  assert.deepEqual(value.injections.map((item) => item.id), ["inj-a"]);
  assert.deepEqual(value.weights.map((item) => item.date), ["2026-10-18"]);
});

run("one weight per day keeps the latest edit", () => {
  const value = Health.normalizeHealth({
    weights: [
      weight("2026-10-18", 87, { id: "w-1", updatedAt: "2026-10-18T01:00:00.000Z" }),
      weight("2026-10-18", 86.4, { id: "w-2", updatedAt: "2026-10-18T09:00:00.000Z" }),
    ],
  });
  assert.equal(value.weights.length, 1);
  assert.equal(value.weights[0].kg, 86.4);
});

run("next dose follows the last injection plus the interval", () => {
  const value = state({ plan: plan(), injections: [injection()] });
  const next = Health.nextDose(value, Core.fromLocalDateKey("2026-10-19", 12 * 60));
  assert.equal(next.lastKey, "2026-10-15");
  assert.equal(next.dueKey, "2026-10-22");
  assert.equal(next.daysUntil, 3);
  assert.equal(next.elapsedDays, 4);
  assert.equal(next.takenToday, false);
});

run("next dose uses the plan start date before the first injection", () => {
  const value = state({ plan: plan({ startDate: "2026-10-20" }) });
  const next = Health.nextDose(value, Core.fromLocalDateKey("2026-10-19", 8 * 60));
  assert.equal(next.dueKey, "2026-10-20");
  assert.equal(next.daysUntil, 1);
  assert.equal(next.progress, 0);
});

run("overdue doses report negative days and a full ring", () => {
  const value = state({ plan: plan(), injections: [injection()] });
  const next = Health.nextDose(value, Core.fromLocalDateKey("2026-10-24", 8 * 60));
  assert.equal(next.daysUntil, -2);
  assert.equal(next.progress, 1);
});

run("no plan means no schedule and never a dose suggestion", () => {
  const value = state({ injections: [injection()] });
  assert.equal(Health.nextDose(value, new Date()), null);
  assert.equal(Object.keys(Health).some((key) => /recommend|calculat/i.test(key)), false);
});

run("day arithmetic is exact across a daylight-saving change", () => {
  const corePath = path.resolve(__dirname, "../android/app/src/main/assets/health-core.js");
  const output = childProcess.execFileSync(process.execPath, [
    "-e",
    `const H=require(${JSON.stringify(corePath)});process.stdout.write(H.addDaysToKey('2026-03-05',7)+' '+H.daysBetween('2026-03-05','2026-03-12'));`,
  ], { encoding: "utf8", env: { ...process.env, TZ: "America/New_York" } });
  assert.equal(output, "2026-03-12 7");
});

run("site rotation moves to the next site after the last one used", () => {
  assert.equal(Health.suggestSite(state()), "abdomen-left");
  assert.equal(Health.suggestSite(state({ injections: [injection({ site: "abdomen-left" })] })), "abdomen-right");
  assert.equal(Health.suggestSite(state({ injections: [injection({ site: "arm-right" })] })), "abdomen-left");
});

run("plans without estimate parameters stay canonical for old backups", () => {
  const old = state({ plan: plan() });
  assert.equal(Health.isCanonicalHealth(old), true);
  assert.equal("halfLifeHours" in old.plan, false);
  const backup = JSON.stringify(Health.makeBackup(old));
  assert.equal(Health.validateBackup(backup).ok, true);
  const withPk = state({ plan: plan({ halfLifeHours: 165, tmaxHours: 48 }) });
  assert.equal(withPk.plan.halfLifeHours, 165);
  assert.equal(Health.isCanonicalHealth(withPk), true);
  assert.equal(Health.validateBackup(JSON.stringify(Health.makeBackup(withPk))).ok, true);
  // A peak time needs absorption faster than elimination: tmax < t½ / ln 2.
  assert.equal("halfLifeHours" in state({ plan: plan({ halfLifeHours: 10, tmaxHours: 20 }) }).plan, false);
  assert.equal(Health.cleanPkParams(165, 48).tmaxHours, 48);
  assert.equal(Health.cleanPkParams(165, null), null);
});

run("level estimate needs parameters and only counts doses in the plan unit", () => {
  assert.equal(Health.levelEstimate(state({ plan: plan() }), new Date()), null);
  const now = Core.fromLocalDateKey("2026-10-19", 9 * 60);
  const value = state({
    plan: plan({ halfLifeHours: 165, tmaxHours: 48 }),
    injections: [
      injection({ id: "a", occurredAt: localIso("2026-10-05", "09:00"), doseValue: 0.25 }),
      injection({ id: "b", occurredAt: localIso("2026-10-10", "09:00"), doseValue: null }),
      injection({ id: "c", occurredAt: localIso("2026-10-12", "09:00"), doseValue: 0.5, doseUnit: "μg" }),
      injection({ id: "d", occurredAt: localIso("2026-10-12", "09:00"), doseValue: 0.5 }),
    ],
  });
  const estimate = Health.levelEstimate(value, now);
  assert.equal(estimate.used, 2);
  assert.equal(estimate.skipped, 2);
  assert.equal(estimate.unit, "mg");
  assert.ok(estimate.current > 0 && estimate.current < 0.75);
  assert.ok(estimate.series.length > 100);
  assert.ok(estimate.series.every((point) => point.value >= 0));
});

run("a single dose peaks near tmax and then halves every half-life", () => {
  const dosed = localIso("2026-09-01", "09:00");
  const value = state({
    plan: plan({ halfLifeHours: 165, tmaxHours: 48 }),
    injections: [injection({ occurredAt: dosed, doseValue: 1 })],
  });
  const hours = (h) => new Date(Date.parse(dosed) + h * 3600000);
  const early = Health.levelEstimate(value, hours(10));
  const peakHours = (early.peak.time - Date.parse(dosed)) / 3600000;
  assert.ok(Math.abs(peakHours - 48) <= 1.5, `peak at ${peakHours} h`);
  assert.ok(early.peak.value < 1);
  const later = Health.levelEstimate(value, hours(800)).current;
  const halved = Health.levelEstimate(value, hours(965)).current;
  assert.ok(Math.abs(halved / later - 0.5) < 0.01, `ratio ${halved / later}`);
  assert.equal(Health.levelEstimate(value, hours(-1)).current, 0);
});

run("medication names map to reference presets", () => {
  assert.equal(Health.matchPkPreset("司美格鲁肽").id, "semaglutide");
  assert.equal(Health.matchPkPreset("Mounjaro 5mg").id, "tirzepatide");
  assert.equal(Health.matchPkPreset("维生素"), null);
  Health.PK_PRESETS.forEach((preset) => assert.ok(Health.cleanPkParams(preset.halfLifeHours, preset.tmaxHours)));
});

run("the site map skips injections logged without a site", () => {
  assert.equal(Health.lastSiteInjection(state()), null);
  const value = state({
    injections: [
      injection({ id: "inj-a", site: "thigh-left" }),
      injection({ id: "inj-b", occurredAt: localIso("2026-10-22", "09:00"), site: "" }),
    ],
  });
  assert.equal(Health.lastSiteInjection(value).id, "inj-a");
  assert.equal(Health.lastInjection(value).id, "inj-b");
  assert.equal(Health.suggestSite(value), "thigh-right");
});

run("weight summary compares with the previous, 7-day and first records", () => {
  const value = state({
    weights: [
      weight("2026-09-18", 92),
      weight("2026-10-10", 88.2),
      weight("2026-10-12", 87.8),
      weight("2026-10-19", 86.9),
    ],
  });
  const summary = Health.weightSummary(value);
  assert.equal(summary.latest.kg, 86.9);
  assert.equal(summary.changePrevious, -0.9);
  assert.equal(summary.change7, -0.9);
  assert.equal(summary.change30, -5.1);
  assert.equal(summary.changeTotal, -5.1);
  assert.equal(Health.weightSeries(value, 7, Core.fromLocalDateKey("2026-10-19", 600)).length, 1);
  assert.equal(Health.weightSeries(value, 0).length, 4);
});

run("jin display converts from canonical kilograms", () => {
  assert.equal(Health.formatWeight(86.9, "kg"), "86.9 kg");
  assert.equal(Health.formatWeight(86.9, "jin"), "173.8 斤");
  assert.equal(Health.toKg(173.8, "jin"), 86.9);
});

run("health backups round-trip and reject anything that would be coerced", () => {
  const value = state({ plan: plan(), injections: [injection()], weights: [weight("2026-10-18", 86.9)] });
  const backup = JSON.parse(JSON.stringify(Health.makeBackup(value)));
  const result = Health.validateBackup(JSON.stringify(backup));
  assert.equal(result.ok, true);
  assert.equal(result.injections, 1);
  assert.equal(result.weights, 1);
  assert.deepEqual(result.state, value);

  const mutations = [
    (data) => { data.injections[0].doseValue = "2.5"; },
    (data) => { data.injections[0].site = "neck"; },
    (data) => { data.weights[0].kg = 999; },
    (data) => { data.plan.intervalDays = 7.5; },
    (data) => { data.version = 2; },
  ];
  mutations.forEach((mutate) => {
    const copy = JSON.parse(JSON.stringify(backup));
    mutate(copy.data);
    assert.equal(Health.validateBackup(copy).ok, false);
  });
  assert.equal(Health.validateBackup({ ...backup, app: "week168" }).ok, false);
});

run("time backups are not mistaken for health backups", () => {
  assert.equal(Health.isHealthBackup(JSON.stringify({ app: "week168", version: 1 })), false);
  assert.equal(Health.isHealthBackup("{broken"), false);
  assert.equal(Health.isHealthBackup(JSON.stringify(Health.makeBackup(state()))), true);
});

run("store saves canonical JSON and loads it without a recovery copy", () => {
  const storage = memoryStorage();
  const store = Health.createStore(storage);
  assert.equal(store.load().enabled, false);
  const saved = store.save(state({ injections: [injection()] }));
  assert.equal(saved.ok, true);
  const reloaded = Health.createStore(storage);
  assert.equal(reloaded.load().injections.length, 1);
  assert.equal(storage.values.has(Health.RECOVERY_KEY), false);
  assert.equal(reloaded.warning(), "");
});

run("damaged health data is preserved and never overwritten silently", () => {
  const raw = "{damaged";
  const storage = memoryStorage({ [Health.STORAGE_KEY]: raw });
  const store = Health.createStore(storage);
  assert.equal(store.load().injections.length, 0);
  assert.equal(storage.values.get(Health.RECOVERY_KEY), raw);
  assert.notEqual(store.warning(), "");

  const noted = JSON.stringify({ ...state({ injections: [injection()] }), extra: true });
  const second = memoryStorage({ [Health.STORAGE_KEY]: noted });
  const secondStore = Health.createStore(second);
  assert.equal(secondStore.load().injections.length, 1);
  assert.equal(second.values.get(Health.RECOVERY_KEY), noted);
});

run("store refuses to save when the recovery copy could not be kept", () => {
  const values = new Map([[Health.STORAGE_KEY, "{damaged"]]);
  const storage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) {
      if (key === Health.RECOVERY_KEY) throw new Error("quota");
      values.set(key, value);
    },
  };
  const store = Health.createStore(storage);
  store.load();
  assert.equal(store.save(state()).ok, false);
  assert.equal(values.get(Health.STORAGE_KEY), "{damaged");
  store.markRecoveryExported();
  assert.equal(store.save(state()).ok, true);
});
