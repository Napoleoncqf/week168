(function (root, factory) {
  const isNode = typeof module === "object" && module.exports;
  const api = factory(isNode ? require("./core.js") : root && root.Time168Core);
  if (isNode) module.exports = api;
  if (root) root.Week168HealthCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Core) {
  "use strict";

  if (!Core) throw new Error("Time168Core is required");

  // Health data lives under its own key so the strict time-record state and
  // its backups stay byte-for-byte compatible with earlier versions.
  const VERSION = 1;
  const STORAGE_KEY = "time168.health.v1";
  const RECOVERY_KEY = "time168.health.recovery.v1";
  const BACKUP_APP = "week168-health";
  const DOSE_UNITS = ["mg", "μg", "mL", "单位"];
  const WEIGHT_UNITS = ["kg", "jin"];
  const SITES = [
    { id: "arm-left", name: "左上臂" },
    { id: "arm-right", name: "右上臂" },
    { id: "abdomen-left", name: "左腹" },
    { id: "abdomen-right", name: "右腹" },
    { id: "thigh-left", name: "左大腿" },
    { id: "thigh-right", name: "右大腿" },
  ];
  const SITE_ROTATION = ["abdomen-left", "abdomen-right", "thigh-left", "thigh-right", "arm-left", "arm-right"];
  const LIMITS = {
    injections: 5000,
    weights: 20000,
    name: 40,
    note: 200,
    intervalMin: 1,
    intervalMax: 60,
    doseMin: 0.001,
    doseMax: 1000,
    kgMin: 20,
    kgMax: 400,
    halfLifeMin: 1,
    halfLifeMax: 2000,
    tmaxMin: 0.5,
    tmaxMax: 336,
  };
  const SITE_IDS = new Set(SITES.map((site) => site.id));
  const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
  const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const HOUR_MS = 60 * 60 * 1000;
  // Rounded reference values from the products' public prescribing
  // information. They only seed the estimate; the user can change them.
  const PK_PRESETS = [
    { id: "semaglutide", name: "司美格鲁肽", halfLifeHours: 165, tmaxHours: 48, aliases: ["semaglutide", "ozempic", "wegovy", "诺和泰", "诺和盈"] },
    { id: "tirzepatide", name: "替尔泊肽", halfLifeHours: 120, tmaxHours: 24, aliases: ["tirzepatide", "mounjaro", "zepbound", "穆峰达"] },
    { id: "dulaglutide", name: "度拉糖肽", halfLifeHours: 112, tmaxHours: 48, aliases: ["dulaglutide", "trulicity", "度易达"] },
    { id: "liraglutide", name: "利拉鲁肽", halfLifeHours: 13, tmaxHours: 11, aliases: ["liraglutide", "victoza", "saxenda", "诺和力"] },
  ];

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function isCanonicalIso(value) {
    if (typeof value !== "string") return false;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  }

  function isDateKey(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Core.fromLocalDateKey(value) !== null;
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function cleanText(value, max) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
  }

  function roundTo(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
  }

  function cleanNumber(value, min, max, decimals) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const rounded = roundTo(value, decimals);
    return rounded >= min && rounded <= max ? rounded : null;
  }

  function cleanDose(value) {
    return value == null ? null : cleanNumber(value, LIMITS.doseMin, LIMITS.doseMax, 3);
  }

  // Calendar arithmetic on YYYY-MM-DD keys. Working in UTC day numbers keeps
  // "every 7 days" exact across daylight-saving changes.
  function dayIndex(key) {
    const [year, month, day] = key.split("-").map(Number);
    return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
  }

  function keyFromDayIndex(index) {
    const date = new Date(index * DAY_MS);
    return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
  }

  function addDaysToKey(key, amount) {
    return keyFromDayIndex(dayIndex(key) + amount);
  }

  function daysBetween(fromKey, toKey) {
    return dayIndex(toKey) - dayIndex(fromKey);
  }

  function defaultHealth() {
    return {
      version: VERSION,
      enabled: false,
      plan: null,
      injections: [],
      weights: [],
      settings: { weightUnit: "kg" },
      updatedAt: new Date().toISOString(),
    };
  }

  function cleanPlan(plan) {
    if (!isPlainObject(plan)) return null;
    const name = cleanText(plan.name, LIMITS.name);
    const intervalDays = Number.isInteger(plan.intervalDays)
      && plan.intervalDays >= LIMITS.intervalMin && plan.intervalDays <= LIMITS.intervalMax
      ? plan.intervalDays : null;
    if (!name || !intervalDays || !isDateKey(plan.startDate)) return null;
    const clean = {
      name,
      doseValue: cleanDose(plan.doseValue),
      doseUnit: DOSE_UNITS.includes(plan.doseUnit) ? plan.doseUnit : "mg",
      intervalDays,
      startDate: plan.startDate,
      reminderEnabled: plan.reminderEnabled === true,
      reminderTime: TIME_PATTERN.test(String(plan.reminderTime || "")) ? plan.reminderTime : "09:00",
    };
    // Estimate parameters are optional and only stored when set, so plans and
    // backups written before they existed stay canonical.
    const pk = cleanPkParams(plan.halfLifeHours, plan.tmaxHours);
    if (pk) Object.assign(clean, pk);
    return clean;
  }

  function cleanPkParams(halfLifeHours, tmaxHours) {
    const halfLife = cleanNumber(halfLifeHours, LIMITS.halfLifeMin, LIMITS.halfLifeMax, 1);
    const tmax = cleanNumber(tmaxHours, LIMITS.tmaxMin, LIMITS.tmaxMax, 1);
    // A peak time only exists while absorption is faster than elimination.
    if (halfLife == null || tmax == null || tmax >= halfLife / Math.LN2) return null;
    return { halfLifeHours: halfLife, tmaxHours: tmax };
  }

  function cleanInjection(item) {
    if (!isPlainObject(item) || typeof item.id !== "string" || !ID_PATTERN.test(item.id)
        || !isCanonicalIso(item.occurredAt)) return null;
    const createdAt = isCanonicalIso(item.createdAt) ? item.createdAt : item.occurredAt;
    return {
      id: item.id,
      occurredAt: item.occurredAt,
      name: cleanText(item.name, LIMITS.name),
      doseValue: cleanDose(item.doseValue),
      doseUnit: DOSE_UNITS.includes(item.doseUnit) ? item.doseUnit : "mg",
      site: SITE_IDS.has(item.site) ? item.site : "",
      note: cleanText(item.note, LIMITS.note),
      createdAt,
      updatedAt: isCanonicalIso(item.updatedAt) ? item.updatedAt : createdAt,
    };
  }

  function cleanWeight(item) {
    if (!isPlainObject(item) || typeof item.id !== "string" || !ID_PATTERN.test(item.id)
        || !isDateKey(item.date)) return null;
    const kg = cleanNumber(item.kg, LIMITS.kgMin, LIMITS.kgMax, 2);
    if (kg == null) return null;
    const createdAt = isCanonicalIso(item.createdAt) ? item.createdAt : new Date().toISOString();
    return {
      id: item.id,
      date: item.date,
      kg,
      note: cleanText(item.note, LIMITS.note),
      createdAt,
      updatedAt: isCanonicalIso(item.updatedAt) ? item.updatedAt : createdAt,
    };
  }

  function keepLast(items, keyOf) {
    const lastIndex = new Map();
    items.forEach((item, index) => lastIndex.set(keyOf(item), index));
    return items.filter((item, index) => lastIndex.get(keyOf(item)) === index);
  }

  function normalizeHealth(input) {
    const clean = defaultHealth();
    if (!isPlainObject(input)) return clean;
    clean.enabled = input.enabled === true;
    clean.plan = cleanPlan(input.plan);
    clean.injections = keepLast(
      (Array.isArray(input.injections) ? input.injections : []).map(cleanInjection).filter(Boolean),
      (item) => item.id
    )
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id))
      .slice(-LIMITS.injections);
    // One weight per calendar day: the trend reads as a daily series.
    const weights = keepLast(
      (Array.isArray(input.weights) ? input.weights : []).map(cleanWeight).filter(Boolean),
      (item) => item.id
    ).sort((a, b) => a.date.localeCompare(b.date) || a.updatedAt.localeCompare(b.updatedAt));
    clean.weights = keepLast(weights, (item) => item.date).slice(-LIMITS.weights);
    const settings = isPlainObject(input.settings) ? input.settings : {};
    clean.settings = { weightUnit: WEIGHT_UNITS.includes(settings.weightUnit) ? settings.weightUnit : "kg" };
    if (isCanonicalIso(input.updatedAt)) clean.updatedAt = input.updatedAt;
    return clean;
  }

  function isCanonicalHealth(value) {
    return isPlainObject(value) && JSON.stringify(normalizeHealth(value)) === JSON.stringify(value);
  }

  function createStore(storage) {
    let warning = "";
    let preservedRaw = "";
    let recoveryProtected = false;

    try {
      preservedRaw = storage.getItem(RECOVERY_KEY) || "";
      recoveryProtected = Boolean(preservedRaw);
    } catch (error) { /* Availability is checked again on load and save. */ }

    function preserve(raw, message) {
      preservedRaw = String(raw || "");
      warning = message;
      recoveryProtected = false;
      try {
        storage.setItem(RECOVERY_KEY, preservedRaw);
        recoveryProtected = true;
      } catch (error) { /* Block overwrites until the copy is exported. */ }
    }

    function load() {
      let raw;
      try {
        raw = storage.getItem(STORAGE_KEY);
      } catch (error) {
        warning = "暂时无法读取健康数据；本次修改可能无法保存";
        return defaultHealth();
      }
      if (!raw) return defaultHealth();
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        preserve(raw, "健康数据异常，原始内容已保护；可在健康页导出抢救副本");
        return defaultHealth();
      }
      if (!isPlainObject(parsed) || parsed.version !== VERSION) {
        preserve(raw, "发现无法识别的健康数据，原始内容已保护");
        return defaultHealth();
      }
      if (!isCanonicalHealth(parsed)) {
        preserve(raw, "部分健康数据格式异常，已保护原始副本并尽量恢复可用内容");
      }
      return normalizeHealth(parsed);
    }

    function save(state) {
      if (preservedRaw && !recoveryProtected) {
        return { ok: false, message: "为避免覆盖异常原数据，请先导出健康抢救副本" };
      }
      const next = normalizeHealth({ ...state, updatedAt: new Date().toISOString() });
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(next));
        return { ok: true, state: next };
      } catch (error) {
        return { ok: false, message: "设备存储空间不足，这次修改未能保存" };
      }
    }

    return {
      load,
      save,
      warning: () => warning,
      recoveryRaw: () => preservedRaw,
      markRecoveryExported() { recoveryProtected = true; },
    };
  }

  function makeBackup(state) {
    return {
      app: BACKUP_APP,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      data: normalizeHealth(state),
    };
  }

  function parseJson(raw) {
    return typeof raw === "string" ? JSON.parse(raw.replace(/^﻿/, "")) : raw;
  }

  function isHealthBackup(raw) {
    try {
      const value = parseJson(raw);
      return isPlainObject(value) && value.app === BACKUP_APP;
    } catch (error) {
      return false;
    }
  }

  function validateBackup(raw) {
    let value;
    try {
      value = parseJson(raw);
    } catch (error) {
      return { ok: false, message: "文件不是有效的 JSON" };
    }
    if (!isPlainObject(value) || value.app !== BACKUP_APP || value.version !== VERSION) {
      return { ok: false, message: "这不是当前版本支持的健康备份" };
    }
    const data = value.data;
    if (!isPlainObject(data) || data.version !== VERSION
        || !Array.isArray(data.injections) || !Array.isArray(data.weights)) {
      return { ok: false, message: "健康备份缺少注射或体重记录" };
    }
    if (data.injections.length > LIMITS.injections || data.weights.length > LIMITS.weights) {
      return { ok: false, message: "健康备份超出安全限制" };
    }
    if (!isCanonicalHealth(data)) {
      return { ok: false, message: "健康备份内容无法无损恢复，为保护原数据未导入" };
    }
    const state = normalizeHealth(data);
    return { ok: true, state, injections: state.injections.length, weights: state.weights.length };
  }

  function lastInjection(state) {
    return state.injections.length ? state.injections[state.injections.length - 1] : null;
  }

  // The schedule only answers "which day is next" from the user's own plan.
  // It never derives or suggests a dose.
  function nextDose(state, now) {
    const plan = state.plan;
    if (!plan) return null;
    const todayKey = Core.toLocalDateKey(now || new Date());
    const last = lastInjection(state);
    const lastKey = last ? Core.toLocalDateKey(last.occurredAt) : "";
    const dueKey = last ? addDaysToKey(lastKey, plan.intervalDays) : plan.startDate;
    const elapsedDays = last ? daysBetween(lastKey, todayKey) : null;
    return {
      dueKey,
      daysUntil: daysBetween(todayKey, dueKey),
      lastKey,
      elapsedDays,
      intervalDays: plan.intervalDays,
      progress: last ? Math.min(1, Math.max(0, elapsedDays / plan.intervalDays)) : 0,
      takenToday: lastKey === todayKey,
    };
  }

  function lastSiteInjection(state) {
    for (let index = state.injections.length - 1; index >= 0; index -= 1) {
      if (state.injections[index].site) return state.injections[index];
    }
    return null;
  }

  function suggestSite(state) {
    const last = lastSiteInjection(state);
    return last ? SITE_ROTATION[(SITE_ROTATION.indexOf(last.site) + 1) % SITE_ROTATION.length] : SITE_ROTATION[0];
  }

  function siteLastUsed(state) {
    const result = Object.create(null);
    state.injections.forEach((item) => {
      if (item.site) result[item.site] = Core.toLocalDateKey(item.occurredAt);
    });
    return result;
  }

  function weightSeries(state, days, now) {
    if (!days) return state.weights.slice();
    const startKey = addDaysToKey(Core.toLocalDateKey(now || new Date()), -(days - 1));
    return state.weights.filter((item) => item.date >= startKey);
  }

  function weightSummary(state) {
    const weights = state.weights;
    if (!weights.length) return null;
    const latest = weights[weights.length - 1];
    const previous = weights.length > 1 ? weights[weights.length - 2] : null;
    const first = weights[0];
    const change = (base) => (base ? roundTo(latest.kg - base.kg, 2) : null);
    const onOrBefore = (days) => {
      const target = addDaysToKey(latest.date, -days);
      let found = null;
      for (const item of weights) {
        if (item.date > target) break;
        found = item;
      }
      return found;
    };
    return {
      latest,
      previous,
      first,
      changePrevious: change(previous),
      change7: change(onOrBefore(7)),
      change30: change(onOrBefore(30)),
      changeTotal: weights.length > 1 ? change(first) : null,
    };
  }

  function matchPkPreset(name) {
    const text = String(name || "").toLowerCase();
    if (!text) return null;
    return PK_PRESETS.find((preset) => [preset.name, ...preset.aliases].some((alias) => text.includes(alias))) || null;
  }

  // One-compartment model with first-order absorption and elimination
  // (Bateman). It is a rough estimate of the amount still in the body, built
  // only from the user's own records and parameters.
  function rateConstants(halfLifeHours, tmaxHours) {
    const ke = Math.LN2 / halfLifeHours;
    const tmaxFor = (ka) => Math.log(ka / ke) / (ka - ke);
    let low = ke * (1 + 1e-9);
    let high = ke * 2;
    while (tmaxFor(high) > tmaxHours) high *= 2;
    for (let step = 0; step < 80; step += 1) {
      const mid = (low + high) / 2;
      if (tmaxFor(mid) > tmaxHours) low = mid;
      else high = mid;
    }
    return { ke, ka: (low + high) / 2 };
  }

  function amountAfter(dose, hours, rates) {
    if (hours < 0) return 0;
    return (dose * rates.ka / (rates.ka - rates.ke)) * (Math.exp(-rates.ke * hours) - Math.exp(-rates.ka * hours));
  }

  // Past series, current amount and the peak after the latest dose. The
  // forward part assumes no further injections. It never suggests a dose.
  function levelEstimate(state, now, options) {
    const plan = state.plan;
    if (!plan || plan.halfLifeHours == null || plan.tmaxHours == null) return null;
    const settings = { pastDays: 14, futureDays: 7, stepHours: 3, ...(options || {}) };
    const rates = rateConstants(plan.halfLifeHours, plan.tmaxHours);
    const at = (now || new Date()).getTime();
    const doses = [];
    let skipped = 0;
    state.injections.forEach((item) => {
      const time = Date.parse(item.occurredAt);
      if (time > at) return;
      if (item.doseValue == null || item.doseUnit !== plan.doseUnit) skipped += 1;
      else doses.push({ time, dose: item.doseValue });
    });
    const levelAt = (time) => doses.reduce((sum, item) => sum + amountAfter(item.dose, (time - item.time) / HOUR_MS, rates), 0);
    const result = {
      unit: plan.doseUnit,
      halfLifeHours: plan.halfLifeHours,
      tmaxHours: plan.tmaxHours,
      now: at,
      used: doses.length,
      skipped,
      current: levelAt(at),
      peak: null,
      series: [],
    };
    if (!doses.length) return result;
    const last = doses[doses.length - 1].time;
    const scanStep = Math.max(0.25, plan.tmaxHours / 48);
    let peak = { time: last, value: 0 };
    for (let hours = 0; hours <= plan.tmaxHours * 3 + scanStep; hours += scanStep) {
      const time = last + hours * HOUR_MS;
      const value = levelAt(time);
      if (value > peak.value) peak = { time, value };
    }
    result.peak = peak;
    const start = at - settings.pastDays * DAY_MS;
    const end = at + settings.futureDays * DAY_MS;
    for (let time = start; time < end; time += settings.stepHours * HOUR_MS) {
      result.series.push({ time, value: levelAt(time) });
    }
    result.series.push({ time: end, value: levelAt(end) });
    return result;
  }

  function displayWeight(kg, unit) {
    return unit === "jin" ? roundTo(kg * 2, 1) : roundTo(kg, 1);
  }

  function toKg(value, unit) {
    return unit === "jin" ? value / 2 : value;
  }

  function weightUnitLabel(unit) {
    return unit === "jin" ? "斤" : "kg";
  }

  function formatWeight(kg, unit) {
    return `${displayWeight(kg, unit).toFixed(1)} ${weightUnitLabel(unit)}`;
  }

  function formatDose(value, unit) {
    return value == null ? "剂量未填" : `${value} ${unit}`;
  }

  function siteName(id) {
    const site = SITES.find((item) => item.id === id);
    return site ? site.name : "";
  }

  return {
    VERSION,
    STORAGE_KEY,
    RECOVERY_KEY,
    BACKUP_APP,
    DOSE_UNITS,
    WEIGHT_UNITS,
    SITES,
    SITE_ROTATION,
    LIMITS,
    isDateKey,
    addDaysToKey,
    daysBetween,
    dayIndex,
    defaultHealth,
    normalizeHealth,
    isCanonicalHealth,
    createStore,
    makeBackup,
    isHealthBackup,
    validateBackup,
    lastInjection,
    nextDose,
    PK_PRESETS,
    matchPkPreset,
    cleanPkParams,
    levelEstimate,
    lastSiteInjection,
    suggestSite,
    siteLastUsed,
    weightSeries,
    weightSummary,
    displayWeight,
    toKg,
    weightUnitLabel,
    formatWeight,
    formatDose,
    siteName,
  };
});
