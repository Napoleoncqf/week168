(function () {
  "use strict";

  const H = window.Week168HealthCore;
  const Core = window.Time168Core;
  if (!H || !Core) return;

  const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
  const SHEETS = [
    ["injectionSheet", "injectionBackdrop"],
    ["weightSheet", "weightBackdrop"],
    ["planSheet", "planBackdrop"],
  ];
  const SITE_LAYOUT = ["arm-left", "arm-right", "abdomen-left", "abdomen-right", "thigh-left", "thigh-right"];
  const RECENT_INJECTIONS = 6;

  let host = null;
  let store = null;
  let state = H.defaultHealth();
  const view = {
    weightRange: 30,
    showAllInjections: false,
    editingInjectionId: "",
    injectionSite: "",
    injectionUnit: "mg",
    planUnit: "mg",
    editingWeightId: "",
    recoveryExportPending: false,
    resizeTimer: 0,
  };

  const $ = (id) => document.getElementById(id);
  const esc = (value) => host.escapeHtml(value);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const bridge = () => (host ? host.bridge() : null);

  function nativeReminderAvailable() {
    const native = bridge();
    return Boolean(native && typeof native.setDoseReminder === "function");
  }

  function todayKey() {
    return Core.toLocalDateKey(new Date());
  }

  function dateLabel(key) {
    const date = Core.fromLocalDateKey(key);
    return date ? `${date.getMonth() + 1}月${date.getDate()}日` : "";
  }

  function weekdayLabel(key) {
    const date = Core.fromLocalDateKey(key);
    return date ? `周${WEEKDAYS[date.getDay()]}` : "";
  }

  function relativeDay(days) {
    if (days === 0) return "今天";
    if (days === 1) return "明天";
    if (days === 2) return "后天";
    if (days === -1) return "昨天";
    return days > 0 ? `${days} 天后` : `${-days} 天前`;
  }

  function signed(value, unit) {
    if (value == null) return "—";
    const shown = H.displayWeight(Math.abs(value), unit);
    if (!shown) return "持平";
    return `${value < 0 ? "↓" : "↑"} ${shown.toFixed(1)}`;
  }

  function intervalLabel(days) {
    if (days === 1) return "每天";
    return days === 7 ? "每周" : `每 ${days} 天`;
  }

  // What the countdown ring shows. Progress is only elapsed days over the
  // user's own interval; nothing here models drug levels.
  function doseStatus(next) {
    if (next.takenToday) {
      return { big: "✓", label: "今天已记", tone: "done", progress: 1, headline: `下次 ${dateLabel(next.dueKey)} ${weekdayLabel(next.dueKey)}` };
    }
    if (next.daysUntil === 0) {
      return { big: "今", label: "注射日", tone: "due", progress: 1, headline: "今天是计划的注射日" };
    }
    if (next.daysUntil > 0) {
      return { big: String(next.daysUntil), label: "天后", tone: "", progress: next.progress, headline: `${dateLabel(next.dueKey)} ${weekdayLabel(next.dueKey)}` };
    }
    return { big: String(-next.daysUntil), label: "天未记", tone: "late", progress: 1, headline: `比计划晚了 ${-next.daysUntil} 天` };
  }

  function ringSvg(progress) {
    const length = 2 * Math.PI * 52;
    const filled = Math.max(0, Math.min(1, progress || 0)) * length;
    const value = filled < 0.5 ? "" : `<circle class="ring-value" cx="60" cy="60" r="52" stroke-dasharray="${filled.toFixed(1)} ${length.toFixed(1)}" transform="rotate(-90 60 60)" />`;
    return `<svg class="ring-svg" viewBox="0 0 120 120" aria-hidden="true"><circle class="ring-track" cx="60" cy="60" r="52" />${value}</svg>`;
  }

  function commit(next) {
    const result = store.save(next);
    if (!result.ok) {
      host.showToast(result.message);
      return false;
    }
    state = result.state;
    return true;
  }

  function commitWithUndo(next, message) {
    const before = clone(state);
    if (!commit(next)) return false;
    syncDoseReminder();
    host.renderAll();
    host.showToast(message, () => {
      if (!commit(before)) return;
      syncDoseReminder();
      host.renderAll();
      host.showToast("已撤销");
    });
    return true;
  }

  // ---- Native dose reminder -------------------------------------------------

  function syncDoseReminder() {
    const native = bridge();
    if (!native || typeof native.setDoseReminder !== "function") return;
    const plan = state.plan;
    const next = H.nextDose(state, new Date());
    const enabled = Boolean(state.enabled && plan && plan.reminderEnabled && next);
    try {
      native.setDoseReminder(
        enabled,
        next ? next.dueKey : "",
        plan ? plan.reminderTime : "09:00",
        plan ? plan.intervalDays : 7
      );
    } catch (error) {
      turnReminderOff("无法同步用药提醒，已保持关闭");
    }
  }

  function turnReminderOff(message) {
    if (!state.plan || !state.plan.reminderEnabled) return;
    const next = clone(state);
    next.plan.reminderEnabled = false;
    if (commit(next)) host.renderAll();
    if (message) host.showToast(message);
  }

  function readNativeDoseState() {
    const native = bridge();
    if (!state.enabled || !native || typeof native.getDoseReminderState !== "function") return;
    try {
      const nativeState = JSON.parse(native.getDoseReminderState());
      if (!nativeState || typeof nativeState.enabled !== "boolean") return;
      // Native is authoritative for whether the alarm survived (permission
      // can be revoked while the app is closed); the page owns the schedule.
      if (!nativeState.enabled && state.plan && state.plan.reminderEnabled) {
        const next = clone(state);
        next.plan.reminderEnabled = false;
        commit(next);
      } else if (nativeState.enabled) {
        syncDoseReminder();
      }
    } catch (error) { /* Keep the locally stored preference. */ }
  }

  // ---- Today glance and settings -------------------------------------------

  function renderTodayCard() {
    const card = $("healthGlance");
    if (!card) return;
    card.hidden = !state.enabled;
    if (!state.enabled) return;
    const next = H.nextDose(state, new Date());
    const status = next ? doseStatus(next) : null;
    const ring = $("glanceRing");
    if (ring) {
      ring.className = `glance-ring ${status ? status.tone : "empty"}`;
      ring.innerHTML = `${ringSvg(status ? status.progress : 0)}<b>${esc(status ? status.big : "+")}</b>`;
    }
    if (!next) {
      setText("glanceDose", "未设置");
      setText("glanceDoseMeta", "点这里设置计划");
    } else if (next.takenToday) {
      setText("glanceDose", "今天已记录");
      setText("glanceDoseMeta", `下次 ${dateLabel(next.dueKey)}`);
    } else if (next.daysUntil === 0) {
      setText("glanceDose", "今天");
      setText("glanceDoseMeta", "是计划的注射日");
    } else if (next.daysUntil > 0) {
      setText("glanceDose", dateLabel(next.dueKey));
      setText("glanceDoseMeta", `${weekdayLabel(next.dueKey)} · ${relativeDay(next.daysUntil)}`);
    } else {
      setText("glanceDose", `晚了 ${-next.daysUntil} 天`);
      setText("glanceDoseMeta", `原计划 ${dateLabel(next.dueKey)}`);
    }
    const summary = H.weightSummary(state);
    const unit = state.settings.weightUnit;
    if (!summary) {
      setText("glanceWeight", "—");
      setText("glanceWeightMeta", "还没有记录");
    } else {
      setText("glanceWeight", H.formatWeight(summary.latest.kg, unit));
      const change = summary.change7 != null ? summary.change7 : summary.changePrevious;
      setText("glanceWeightMeta", change == null
        ? dateLabel(summary.latest.date)
        : `${summary.change7 != null ? "7 天" : "较上次"} ${signed(change, unit)}`);
    }
    card.classList.toggle("due", Boolean(next && !next.takenToday && next.daysUntil <= 0));
  }

  function renderSettings() {
    const toggle = $("healthEnabled");
    if (toggle) toggle.checked = state.enabled;
  }

  function setEnabled(enabled) {
    const next = clone(state);
    next.enabled = Boolean(enabled);
    if (!commit(next)) {
      renderSettings();
      return;
    }
    syncDoseReminder();
    renderSettings();
    host.showToast(enabled ? "健康追踪已开启，可从「今天」页进入" : "健康追踪已关闭，记录仍保留在本机");
  }

  function setText(id, value) {
    const element = $(id);
    if (element) element.textContent = value;
  }

  // ---- Health page ----------------------------------------------------------

  function render() {
    renderDoseCard();
    renderTiles();
    renderTodayList();
    renderLevelCard();
    renderSiteMap();
    renderWeightCard();
    renderInjectionList();
    renderDataCard();
  }

  function renderDoseCard() {
    const root = $("doseCard");
    if (!root) return;
    const plan = state.plan;
    if (!plan) {
      root.className = "card dose-card";
      root.innerHTML = `<div class="health-empty"><span class="health-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m18 2 4 4" /><path d="m17 7 3-3" /><path d="M19 9 8.7 19.3a1 1 0 0 1-1.4 0l-2.6-2.6a1 1 0 0 1 0-1.4L15 5" /><path d="m9 11 4 4" /><path d="m5 19-3 3" /><path d="m14 4 6 6" /></svg></span><div><strong>还没有用药计划</strong><p>填上药物名称和间隔，这里会显示下一针在哪天。</p></div></div><div class="two-buttons"><button class="button secondary" type="button" data-action="health-new-injection">先记一针</button><button class="button primary dose-fill" type="button" data-action="health-open-plan">设置计划</button></div>`;
      return;
    }
    const next = H.nextDose(state, new Date());
    const status = doseStatus(next);
    let reminderText = "提醒未开";
    if (!nativeReminderAvailable()) reminderText = "网页版无提醒";
    else if (plan.reminderEnabled) reminderText = `提醒 ${plan.reminderTime}`;
    const reminderOn = plan.reminderEnabled && nativeReminderAvailable();
    const bell = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>';
    root.className = `card dose-card ${status.tone}`;
    root.innerHTML = `<div class="dose-head"><p class="eyebrow">下一针</p><span class="reminder-chip${reminderOn ? " on" : ""}">${bell}${esc(reminderText)}</span></div><div class="dose-main"><div class="dose-ring">${ringSvg(status.progress)}<div><strong>${esc(status.big)}</strong><small>${esc(status.label)}</small></div></div><div class="dose-copy"><h2>${esc(status.headline)}</h2><p class="dose-name">${esc(plan.name)}</p><p class="dose-plan"><span>${esc(H.formatDose(plan.doseValue, plan.doseUnit))}</span><span>${esc(intervalLabel(plan.intervalDays))}</span></p></div></div><div class="two-buttons"><button class="button secondary" type="button" data-action="health-open-plan">调整计划</button><button class="button primary dose-fill" type="button" data-action="health-new-injection">记录一针</button></div>`;
  }

  const TILE_ICONS = {
    dose: '<svg viewBox="0 0 24 24"><path d="m18 2 4 4" /><path d="m17 7 3-3" /><path d="M19 9 8.7 19.3a1 1 0 0 1-1.4 0l-2.6-2.6a1 1 0 0 1 0-1.4L15 5" /><path d="m9 11 4 4" /><path d="m5 19-3 3" /><path d="m14 4 6 6" /></svg>',
    weight: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5" /><path d="M7.5 10a5 5 0 0 1 9 0" /><path d="m12 10 1.6-2.4" /></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></svg>',
  };

  function tileHead(kind, label) {
    return `<span class="tile-head"><span class="tile-icon" aria-hidden="true">${TILE_ICONS[kind]}</span>${esc(label)}</span>`;
  }

  function renderTiles() {
    const lastTile = $("lastDoseTile");
    if (lastTile) {
      const last = H.lastInjection(state);
      if (!last) {
        lastTile.dataset.action = "health-new-injection";
        delete lastTile.dataset.id;
        lastTile.innerHTML = `${tileHead("dose", "上一针")}<strong class="tile-value muted">还没有</strong><span class="tile-line">点这里记一针</span>`;
      } else {
        const key = Core.toLocalDateKey(last.occurredAt);
        lastTile.dataset.action = "health-edit-injection";
        lastTile.dataset.id = last.id;
        const detail = [H.formatDose(last.doseValue, last.doseUnit), H.siteName(last.site)].filter(Boolean).join(" · ");
        lastTile.innerHTML = `${tileHead("dose", "上一针")}<strong class="tile-value">${esc(relativeDay(H.daysBetween(todayKey(), key)))}</strong><span class="tile-line">${esc(`${dateLabel(key)} ${weekdayLabel(key)}`)}</span><span class="tile-line">${esc(detail)}</span>`;
      }
    }
    const weightTile = $("weightTile");
    if (weightTile) {
      const unit = state.settings.weightUnit;
      const summary = H.weightSummary(state);
      if (!summary) {
        weightTile.innerHTML = `${tileHead("weight", "体重")}<strong class="tile-value muted">—</strong><span class="tile-line">点这里记体重</span>`;
      } else {
        const change = (label, value) => `<span class="tile-change${value == null ? " empty" : ""}"><small>${label}</small>${esc(signed(value, unit))}</span>`;
        weightTile.innerHTML = `${tileHead("weight", "体重")}<strong class="tile-value">${esc(H.displayWeight(summary.latest.kg, unit).toFixed(1))}<small>${esc(H.weightUnitLabel(unit))}</small></strong><span class="tile-changes">${change("7 天", summary.change7)}${change("30 天", summary.change30)}</span>`;
      }
    }
  }

  function todayRow({ action, id, done, title, meta, tone, cta }) {
    return `<button class="today-row${done ? " done" : ""}${tone ? ` ${tone}` : ""}" type="button" data-action="${action}"${id ? ` data-id="${esc(id)}"` : ""}><span class="today-check" aria-hidden="true">${done ? TILE_ICONS.check : ""}</span><span class="today-copy"><strong>${esc(title)}</strong><small>${esc(meta)}</small></span><span class="today-cta">${esc(cta)}</span></button>`;
  }

  function renderTodayList() {
    const root = $("healthTodayList");
    if (!root) return;
    const today = todayKey();
    setText("healthTodayDate", `${dateLabel(today)} ${weekdayLabel(today)}`);
    const rows = [];
    const plan = state.plan;
    const next = H.nextDose(state, new Date());
    const dose = plan ? H.formatDose(plan.doseValue, plan.doseUnit) : "";
    if (next && next.takenToday) {
      const last = H.lastInjection(state);
      const time = Core.minutesToTime(Core.minutesOfDay(new Date(last.occurredAt)));
      rows.push(todayRow({
        action: "health-edit-injection", id: last.id, done: true,
        title: `注射 · ${last.name || plan.name}`,
        meta: [H.formatDose(last.doseValue, last.doseUnit), H.siteName(last.site)].filter(Boolean).join(" · "),
        cta: `已记录 ${time}`,
      }));
    } else if (next && next.daysUntil <= 0) {
      const late = next.daysUntil < 0;
      rows.push(todayRow({
        action: "health-new-injection",
        title: `注射 · ${plan.name}`,
        meta: late ? `比计划晚了 ${-next.daysUntil} 天` : `${dose} · 建议 ${H.siteName(H.suggestSite(state))}`,
        tone: late ? "late" : "due",
        cta: "记录一针",
      }));
    }
    const unit = state.settings.weightUnit;
    const weighed = state.weights.find((item) => item.date === today);
    rows.push(weighed
      ? todayRow({ action: "health-edit-weight", id: weighed.id, done: true, title: "体重", meta: weighed.note || "今天已记", tone: "weight", cta: H.formatWeight(weighed.kg, unit) })
      : todayRow({ action: "health-new-weight", title: "体重", meta: "每天一条就能看到趋势", tone: "weight", cta: "记体重" }));
    root.innerHTML = rows.join("");
  }

  // Front view, mirrored like looking down at yourself: the user's left side
  // is drawn on the left. Spots sit on the BODY_SHAPES drawing below.
  const SITE_SPOTS = {
    "arm-left": [41, 108],
    "arm-right": [159, 108],
    "abdomen-left": [86, 128],
    "abdomen-right": [114, 128],
    "thigh-left": [83, 200],
    "thigh-right": [117, 200],
  };
  const BODY_SHAPES = '<circle cx="100" cy="30" r="20" /><rect x="91" y="44" width="18" height="16" rx="6" /><path d="M64 64c0-6 6-10 13-10h46c7 0 13 4 13 10l-2 92c0 6-5 10-11 10H77c-6 0-11-4-11-10z" /><rect x="36" y="58" width="22" height="104" rx="11" transform="rotate(7 47 58)" /><rect x="142" y="58" width="22" height="104" rx="11" transform="rotate(-7 153 58)" /><rect x="68" y="150" width="30" height="122" rx="14" /><rect x="102" y="150" width="30" height="122" rx="14" />';

  function renderSiteMap() {
    const root = $("siteMap");
    if (!root) return;
    const last = H.lastSiteInjection(state);
    const suggested = H.suggestSite(state);
    const used = H.siteLastUsed(state);
    const today = todayKey();
    const spots = SITE_LAYOUT.map((id) => {
      const [cx, cy] = SITE_SPOTS[id];
      const role = last && last.site === id ? "last" : id === suggested ? "next" : used[id] ? "used" : "";
      const halo = role === "next" ? `<circle class="spot-halo" cx="${cx}" cy="${cy}" r="17" />` : "";
      return `${halo}<circle class="spot ${role}" cx="${cx}" cy="${cy}" r="10"><title>${esc(H.siteName(id))}</title></circle>`;
    }).join("");
    const figure = `<svg class="body-map" viewBox="18 4 164 272" role="img" aria-label="注射部位示意：${last ? `上次 ${esc(H.siteName(last.site))}，` : ""}建议下次 ${esc(H.siteName(suggested))}"><g class="body-shape">${BODY_SHAPES}</g><text class="body-side" x="24" y="30">左</text><text class="body-side" x="176" y="30" text-anchor="end">右</text>${spots}</svg>`;
    const lastKey = last ? Core.toLocalDateKey(last.occurredAt) : "";
    const legend = `<div class="site-legend"><div class="site-key last"><i></i><span><small>上次</small><strong>${esc(last ? H.siteName(last.site) : "还没有记录")}</strong>${last ? `<em>${esc(`${dateLabel(lastKey)} · ${relativeDay(H.daysBetween(today, lastKey))}`)}</em>` : ""}</span></div><div class="site-key next"><i></i><span><small>建议下次</small><strong>${esc(H.siteName(suggested))}</strong>${used[suggested] ? `<em>${esc(`上回 ${relativeDay(H.daysBetween(today, used[suggested]))}`)}</em>` : "<em>还没用过</em>"}</span></div><button class="button secondary compact" type="button" data-action="health-new-injection">记录一针</button></div>`;
    root.innerHTML = figure + legend;
  }

  function formatAmount(value, unit) {
    const digits = value >= 10 ? 1 : value >= 0.1 ? 2 : 3;
    return `${value.toFixed(digits)} ${unit}`;
  }

  function spanLabel(ms) {
    const hours = Math.round(Math.abs(ms) / 3600000);
    if (hours < 1) return "不到 1 小时";
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    if (!days) return `${hours} 小时`;
    return rest ? `${days} 天 ${rest} 小时` : `${days} 天`;
  }

  function renderLevelCard() {
    const root = $("levelBody");
    if (!root) return;
    const plan = state.plan;
    const estimate = H.levelEstimate(state, new Date());
    if (!estimate) {
      const preset = plan ? H.matchPkPreset(plan.name) : null;
      const text = !plan
        ? "设置用药计划并选择药物参考值后，这里会按你的注射记录估算体内残留量。"
        : `在用药计划里选择${preset ? `「${preset.name}」的` : "药物"}参考值或填写半衰期，这里会估算体内残留量。`;
      root.innerHTML = `<div class="level-empty"><p>${esc(text)}</p><button class="button secondary compact" type="button" data-action="health-open-plan">${plan ? "设置估算参数" : "设置计划"}</button></div>`;
      return;
    }
    if (!estimate.used) {
      root.innerHTML = `<div class="level-empty"><p>还没有可计入的注射。估算只用填了剂量、且单位为 ${esc(estimate.unit)} 的记录。</p><button class="button secondary compact" type="button" data-action="health-new-injection">记录一针</button></div>`;
      return;
    }
    const peak = estimate.peak;
    const ahead = peak.time > estimate.now;
    const params = `半衰期 ${hoursLabel(estimate.halfLifeHours)} · 达峰 ${hoursLabel(estimate.tmaxHours)}`;
    const skipped = estimate.skipped ? ` · ${estimate.skipped} 针未计入（缺剂量或单位不同）` : "";
    root.innerHTML = `<div class="level-stats"><div><small>当前估算残留</small><strong>${esc(formatAmount(estimate.current, estimate.unit))}</strong></div><div class="level-peak${ahead ? " ahead" : ""}"><small>${ahead ? "峰值约在" : "峰值已过"}</small><strong>${esc(ahead ? `${spanLabel(peak.time - estimate.now)}后` : `${spanLabel(estimate.now - peak.time)}前`)}</strong><em>${esc(`约 ${formatAmount(peak.value, estimate.unit)}`)}</em></div></div><div class="level-chart" id="levelChart"></div><p class="level-meta">${esc(params + skipped)}<br />虚线是之后不再注射时的走向</p>`;
    renderLevelChart(estimate);
  }

  function renderLevelChart(estimate) {
    const root = $("levelChart");
    if (!root || !estimate || !estimate.series.length) return;
    const width = Math.max(260, Math.round(root.clientWidth || 300));
    const height = 150;
    const pad = { top: 14, right: 10, bottom: 26, left: 40 };
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const series = estimate.series;
    const start = series[0].time;
    const end = series[series.length - 1].time;
    const top = Math.max(...series.map((point) => point.value), estimate.peak.value) * 1.15 || 1;
    const x = (time) => pad.left + ((time - start) / (end - start)) * innerW;
    const y = (value) => pad.top + (1 - value / top) * innerH;
    const nowPoint = { time: estimate.now, value: estimate.current };
    const past = series.filter((point) => point.time < estimate.now).concat(nowPoint);
    const future = [nowPoint].concat(series.filter((point) => point.time > estimate.now));
    const path = (points) => points.map((point, index) => `${index ? "L" : "M"}${x(point.time).toFixed(1)} ${y(point.value).toFixed(1)}`).join(" ");
    const bottom = pad.top + innerH;
    const area = `${path(past)} L${x(estimate.now).toFixed(1)} ${bottom} L${x(past[0].time).toFixed(1)} ${bottom} Z`;
    const nowX = x(estimate.now).toFixed(1);
    const grid = [0, 0.5, 1].map((ratio) => {
      const gy = (pad.top + innerH * ratio).toFixed(1);
      const value = top * (1 - ratio);
      return `<line class="chart-grid" x1="${pad.left}" x2="${width - pad.right}" y1="${gy}" y2="${gy}" /><text class="chart-axis" x="${pad.left - 6}" y="${(Number(gy) + 3.5).toFixed(1)}" text-anchor="end">${value >= 10 ? value.toFixed(0) : value.toFixed(value >= 1 ? 1 : 2)}</text>`;
    }).join("");
    const shortDate = (time) => { const date = new Date(time); return `${date.getMonth() + 1}/${date.getDate()}`; };
    const ticks = state.injections
      .map((item) => Date.parse(item.occurredAt))
      .filter((time) => time >= start && time <= estimate.now)
      .map((time) => `<circle class="chart-dose" cx="${x(time).toFixed(1)}" cy="${bottom + 8}" r="2.6" />`).join("");
    const peakInRange = estimate.peak.time >= start && estimate.peak.time <= end;
    const peakDot = peakInRange ? `<circle class="level-peak-dot" cx="${x(estimate.peak.time).toFixed(1)}" cy="${y(estimate.peak.value).toFixed(1)}" r="3.5" />` : "";
    root.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="估算残留水平曲线，当前约 ${esc(formatAmount(estimate.current, estimate.unit))}"><defs><linearGradient id="levelArea" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" style="stop-color:var(--dose);stop-opacity:.3" /><stop offset="100%" style="stop-color:var(--dose);stop-opacity:0" /></linearGradient></defs>${grid}<path d="${area}" fill="url(#levelArea)" stroke="none" /><path class="level-line" d="${path(past)}" /><path class="level-line future" d="${path(future)}" /><line class="level-now" x1="${nowX}" x2="${nowX}" y1="${pad.top - 4}" y2="${bottom}" />${peakDot}<circle class="chart-last level-last" cx="${nowX}" cy="${y(estimate.current).toFixed(1)}" r="4.5" />${ticks}<text class="chart-axis" x="${pad.left}" y="${height - 6}">${shortDate(start)}</text><text class="chart-axis level-now-label" x="${nowX}" y="${height - 6}" text-anchor="middle">现在</text><text class="chart-axis" x="${width - pad.right}" y="${height - 6}" text-anchor="end">${shortDate(end)}</text></svg>`;
  }

  function renderWeightCard() {
    const unit = state.settings.weightUnit;
    const summary = H.weightSummary(state);
    if (!summary) {
      setText("weightHeadline", "还没有记录");
      setText("weightSubline", "每天记一次就能看到趋势");
    } else {
      setText("weightHeadline", H.formatWeight(summary.latest.kg, unit));
      setText("weightSubline", `${dateLabel(summary.latest.date)} ${weekdayLabel(summary.latest.date)}${summary.latest.note ? ` · ${summary.latest.note}` : ""}`);
    }
    const stats = $("weightStats");
    if (stats) {
      stats.innerHTML = summary
        ? [["较上次", summary.changePrevious], ["7 天", summary.change7], ["累计", summary.changeTotal]]
          .map(([label, value]) => `<span class="weight-stat${value == null ? " empty" : ""}"><small>${label}</small><strong>${esc(signed(value, unit))}</strong></span>`).join("")
        : "";
      stats.hidden = !summary;
    }
    all("#weightRange [data-days]").forEach((button) => {
      const active = Number(button.dataset.days) === view.weightRange;
      button.classList.toggle("active", active);
      button.setAttribute("aria-checked", String(active));
    });
    renderWeightChart();
    renderWeightRecent();
  }

  function all(selector) {
    return Array.from(document.querySelectorAll(selector));
  }

  function renderWeightChart() {
    const root = $("weightChart");
    if (!root) return;
    const unit = state.settings.weightUnit;
    const now = new Date();
    const points = H.weightSeries(state, view.weightRange, now);
    if (!points.length) {
      root.innerHTML = `<div class="chart-empty"><span aria-hidden="true">〰</span>${state.weights.length ? "这个范围内还没有体重记录" : "记下第一条体重，这里会画出你的趋势"}</div>`;
      return;
    }
    const width = Math.max(260, Math.round(root.clientWidth || 320));
    const height = 176;
    const pad = { top: 18, right: 16, bottom: 30, left: 38 };
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const values = points.map((item) => H.displayWeight(item.kg, unit));
    const low = Math.min(...values);
    const high = Math.max(...values);
    const span = Math.max(high - low, unit === "jin" ? 2 : 1);
    const mid = (high + low) / 2;
    const min = mid - span * 0.65;
    const max = mid + span * 0.65;
    const today = todayKey();
    let startIndex = view.weightRange ? H.dayIndex(today) - (view.weightRange - 1) : H.dayIndex(points[0].date);
    let endIndex = view.weightRange ? H.dayIndex(today) : H.dayIndex(points[points.length - 1].date);
    if (endIndex <= startIndex) {
      startIndex -= 1;
      endIndex += 1;
    }
    const x = (key) => pad.left + ((H.dayIndex(key) - startIndex) / (endIndex - startIndex)) * innerW;
    const y = (value) => pad.top + ((max - value) / (max - min)) * innerH;
    const coords = points.map((item, index) => [x(item.date), y(values[index])]);
    const line = coords.map(([px, py], index) => `${index ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`).join(" ");
    const bottom = pad.top + innerH;
    const area = `${line} L${coords[coords.length - 1][0].toFixed(1)} ${bottom} L${coords[0][0].toFixed(1)} ${bottom} Z`;
    const grid = [0, 0.5, 1].map((ratio) => {
      const value = max - (max - min) * ratio;
      const gy = pad.top + innerH * ratio;
      return `<line class="chart-grid" x1="${pad.left}" x2="${width - pad.right}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}" /><text class="chart-axis" x="${pad.left - 8}" y="${(gy + 3.5).toFixed(1)}" text-anchor="end">${value.toFixed(1)}</text>`;
    }).join("");
    const firstKey = H.addDaysToKey("1970-01-01", startIndex);
    const lastKey = H.addDaysToKey("1970-01-01", endIndex);
    const shortDate = (key) => key.slice(5).replace("-", "/").replace(/^0/, "");
    const axis = `<text class="chart-axis" x="${pad.left}" y="${height - 8}">${shortDate(firstKey)}</text><text class="chart-axis" x="${width - pad.right}" y="${height - 8}" text-anchor="end">${shortDate(lastKey)}</text>`;
    const doseTicks = state.injections
      .map((item) => Core.toLocalDateKey(item.occurredAt))
      .filter((key) => H.dayIndex(key) >= startIndex && H.dayIndex(key) <= endIndex)
      .map((key) => `<circle class="chart-dose" cx="${x(key).toFixed(1)}" cy="${bottom + 9}" r="2.6"><title>${dateLabel(key)} 注射</title></circle>`)
      .join("");
    const showDots = points.length <= 40;
    const dots = showDots
      ? coords.slice(0, -1).map(([px, py]) => `<circle class="chart-dot" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.6" />`).join("")
      : "";
    const [lx, ly] = coords[coords.length - 1];
    const lastValue = values[values.length - 1].toFixed(1);
    const labelX = Math.min(width - pad.right - 2, Math.max(pad.left + 20, lx));
    const labelY = ly < pad.top + 22 ? ly + 22 : ly - 12;
    const hint = points.length === 1 ? `<text class="chart-hint" x="${(pad.left + innerW / 2).toFixed(1)}" y="${(pad.top + innerH / 2 + 30).toFixed(1)}" text-anchor="middle">再记一天就能连成趋势</text>` : "";
    root.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="体重趋势，最新 ${lastValue} ${H.weightUnitLabel(unit)}"><defs><linearGradient id="weightArea" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" style="stop-color:var(--weight);stop-opacity:.28" /><stop offset="100%" style="stop-color:var(--weight);stop-opacity:0" /></linearGradient></defs>${grid}${points.length > 1 ? `<path d="${area}" fill="url(#weightArea)" stroke="none" /><path class="chart-line" d="${line}" />` : ""}${dots}<circle class="chart-halo" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="9" /><circle class="chart-last" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="4.5" /><text class="chart-label" x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle">${lastValue}</text>${doseTicks}${axis}${hint}</svg>${doseTicks ? '<p class="chart-legend"><i></i>底部圆点是注射日</p>' : ""}`;
  }

  function renderWeightRecent() {
    const root = $("weightRecent");
    if (!root) return;
    const unit = state.settings.weightUnit;
    const recent = state.weights.slice(-4).reverse();
    root.innerHTML = recent.map((item, index) => {
      const previous = state.weights[state.weights.length - 2 - index];
      const delta = previous ? item.kg - previous.kg : null;
      return `<button class="weight-row" type="button" data-action="health-edit-weight" data-id="${esc(item.id)}"><span>${esc(dateLabel(item.date))}<small>${esc(weekdayLabel(item.date))}</small></span><strong>${esc(H.formatWeight(item.kg, unit))}</strong><em>${esc(delta == null ? "" : signed(delta, unit))}</em></button>`;
    }).join("");
    root.hidden = !recent.length;
  }

  function renderInjectionList() {
    const root = $("injectionList");
    if (!root) return;
    const count = state.injections.length;
    setText("injectionHeadline", count ? `共 ${count} 针` : "还没有记录");
    setText("planHeaderButton", state.plan ? "用药计划" : "设置计划");
    if (!count) {
      root.innerHTML = '<div class="empty-card">每次注射后记一笔，部位和间隔会自动整理在这里。</div>';
      return;
    }
    const items = state.injections.slice().reverse();
    const shown = view.showAllInjections ? items : items.slice(0, RECENT_INJECTIONS);
    root.innerHTML = shown.map((item, index) => {
      const date = new Date(item.occurredAt);
      const key = Core.toLocalDateKey(date);
      const older = items[index + 1];
      const gap = older ? H.daysBetween(Core.toLocalDateKey(older.occurredAt), key) : null;
      const title = [item.name || "注射", H.formatDose(item.doseValue, item.doseUnit)].join(" · ");
      const meta = [weekdayLabel(key), Core.minutesToTime(Core.minutesOfDay(date)), H.siteName(item.site), item.note].filter(Boolean).join(" · ");
      return `<button class="injection-row" type="button" data-action="health-edit-injection" data-id="${esc(item.id)}"><span class="injection-date"><strong>${date.getDate()}</strong><small>${date.getMonth() + 1}月</small></span><span class="injection-copy"><strong>${esc(title)}</strong><small>${esc(meta)}</small></span><span class="injection-gap">${gap == null ? "首针" : `+${gap} 天`}</span></button>`;
    }).join("") + (count > RECENT_INJECTIONS
      ? `<button class="text-button list-more" type="button" data-action="health-toggle-injections">${view.showAllInjections ? "收起" : `显示全部 ${count} 条`}</button>`
      : "");
  }

  function renderDataCard() {
    all("#weightUnitToggle [data-unit]").forEach((button) => {
      const active = button.dataset.unit === state.settings.weightUnit;
      button.classList.toggle("active", active);
      button.setAttribute("aria-checked", String(active));
    });
    const raw = store ? store.recoveryRaw() : "";
    const notice = $("healthRecoveryNotice");
    const button = $("healthRecoveryButton");
    if (notice) notice.hidden = !raw;
    if (button) button.hidden = !raw;
  }

  // ---- Sheets ---------------------------------------------------------------

  function openSheet(sheetId) {
    const pair = SHEETS.find(([id]) => id === sheetId);
    host.setSheetOpen(pair[0], pair[1], true);
    window.requestAnimationFrame(() => { $(sheetId).scrollTop = 0; });
  }

  function activeSheet() {
    const pair = SHEETS.find(([id]) => $(id) && !$(id).classList.contains("hidden"));
    return pair ? $(pair[0]) : null;
  }

  function closeActiveSheet() {
    const sheet = activeSheet();
    if (!sheet) return false;
    const pair = SHEETS.find(([id]) => id === sheet.id);
    host.setSheetOpen(pair[0], pair[1], false);
    return true;
  }

  function renderUnitPicker(rootId, selected, action) {
    const root = $(rootId);
    if (!root) return;
    root.innerHTML = H.DOSE_UNITS.map((unit) => `<button type="button" role="radio" class="${unit === selected ? "active" : ""}" aria-checked="${unit === selected}" data-action="${action}" data-unit="${esc(unit)}">${esc(unit)}</button>`).join("");
  }

  function renderSitePicker() {
    const root = $("sitePicker");
    if (!root) return;
    const lastUsed = H.siteLastUsed(state);
    const suggested = H.suggestSite(state);
    const today = todayKey();
    root.innerHTML = SITE_LAYOUT.map((id) => {
      const used = lastUsed[id];
      const meta = used ? relativeDay(H.daysBetween(today, used)) : "未用过";
      const selected = id === view.injectionSite;
      return `<button type="button" class="site-choice${selected ? " selected" : ""}${id === suggested ? " suggested" : ""}" data-action="health-pick-site" data-site="${id}" aria-pressed="${selected}"><strong>${esc(H.siteName(id))}</strong><small>${esc(id === suggested ? "下一处" : meta)}</small></button>`;
    }).join("");
  }

  function openInjection(id) {
    const existing = id ? state.injections.find((item) => item.id === id) : null;
    if (id && !existing) {
      host.showToast("这条记录已不存在");
      return;
    }
    const last = H.lastInjection(state);
    const plan = state.plan;
    const now = new Date();
    const when = existing ? new Date(existing.occurredAt) : now;
    view.editingInjectionId = existing ? existing.id : "";
    view.injectionSite = existing ? existing.site : H.suggestSite(state);
    view.injectionUnit = existing ? existing.doseUnit : (plan ? plan.doseUnit : (last ? last.doseUnit : "mg"));
    const dose = existing ? existing.doseValue : (plan && plan.doseValue != null ? plan.doseValue : (last ? last.doseValue : null));
    $("injectionDate").value = Core.toLocalDateKey(when);
    $("injectionDate").max = todayKey();
    $("injectionTime").value = Core.minutesToTime(Core.minutesOfDay(when));
    $("injectionName").value = existing ? existing.name : (plan ? plan.name : (last ? last.name : ""));
    $("injectionDose").value = dose == null ? "" : String(dose);
    $("injectionNote").value = existing ? existing.note : "";
    setText("injectionSheetTitle", existing ? "编辑注射记录" : "记录一针");
    $("injectionEditActions").classList.toggle("hidden", !existing);
    renderUnitPicker("injectionUnits", view.injectionUnit, "health-pick-dose-unit");
    renderSitePicker();
    openSheet("injectionSheet");
  }

  function parseDose(inputId) {
    const raw = $(inputId).value.trim();
    if (!raw) return { ok: true, value: null };
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value > H.LIMITS.doseMax) {
      host.showToast("剂量需大于 0，且不超过 1000");
      return { ok: false };
    }
    return { ok: true, value: Math.round(value * 1000) / 1000 };
  }

  function saveInjection() {
    const key = $("injectionDate").value;
    const minutes = Core.parseTime($("injectionTime").value);
    if (!H.isDateKey(key) || minutes == null) {
      host.showToast("请选择有效的日期和时间");
      return;
    }
    const occurred = Core.fromLocalDateKey(key, minutes);
    if (occurred.getTime() > Date.now() + 5 * 60 * 1000) {
      host.showToast("注射时间不能晚于现在");
      return;
    }
    const dose = parseDose("injectionDose");
    if (!dose.ok) return;
    const existing = view.editingInjectionId ? state.injections.find((item) => item.id === view.editingInjectionId) : null;
    const nowIso = new Date().toISOString();
    const record = {
      id: existing ? existing.id : Core.makeId("inj"),
      occurredAt: occurred.toISOString(),
      name: $("injectionName").value.trim().slice(0, H.LIMITS.name),
      doseValue: dose.value,
      doseUnit: view.injectionUnit,
      site: view.injectionSite,
      note: $("injectionNote").value.trim().slice(0, H.LIMITS.note),
      createdAt: existing ? existing.createdAt : nowIso,
      updatedAt: nowIso,
    };
    const next = clone(state);
    next.injections = next.injections.filter((item) => item.id !== record.id).concat(record);
    closeActiveSheet();
    commitWithUndo(next, existing ? "注射记录已更新" : "已记下这一针");
  }

  function deleteInjection() {
    const id = view.editingInjectionId;
    if (!id || !window.confirm("确定删除这条注射记录吗？删除后可在 8 秒内撤销。")) return;
    const next = clone(state);
    next.injections = next.injections.filter((item) => item.id !== id);
    closeActiveSheet();
    commitWithUndo(next, "注射记录已删除");
  }

  function fillWeightForDate(key) {
    const unit = state.settings.weightUnit;
    const existing = state.weights.find((item) => item.date === key);
    const latest = state.weights[state.weights.length - 1];
    view.editingWeightId = existing ? existing.id : "";
    const base = existing || latest;
    $("weightValue").value = base ? H.displayWeight(base.kg, unit).toFixed(1) : "";
    $("weightNote").value = existing ? existing.note : "";
    setText("weightSheetTitle", existing ? "修改体重" : "记体重");
    setText("weightHelper", existing ? "这天已有记录，保存会更新它" : "每天保留一条，同一天再次保存会更新它");
    $("weightEditActions").classList.toggle("hidden", !existing);
  }

  function openWeight(id) {
    const existing = id ? state.weights.find((item) => item.id === id) : null;
    const key = existing ? existing.date : todayKey();
    $("weightDate").value = key;
    $("weightDate").max = todayKey();
    setText("weightUnitLabel", H.weightUnitLabel(state.settings.weightUnit));
    fillWeightForDate(key);
    openSheet("weightSheet");
  }

  function stepWeight(direction) {
    const input = $("weightValue");
    const current = Number(input.value);
    const latest = state.weights[state.weights.length - 1];
    const base = Number.isFinite(current) && input.value !== ""
      ? current
      : (latest ? H.displayWeight(latest.kg, state.settings.weightUnit) : (state.settings.weightUnit === "jin" ? 140 : 70));
    input.value = Math.max(0, Math.round((base + direction * 0.1) * 10) / 10).toFixed(1);
  }

  function saveWeight() {
    const key = $("weightDate").value;
    if (!H.isDateKey(key) || key > todayKey()) {
      host.showToast("请选择今天或更早的日期");
      return;
    }
    const unit = state.settings.weightUnit;
    const shown = Number($("weightValue").value);
    const kg = Math.round(H.toKg(shown, unit) * 100) / 100;
    if (!$("weightValue").value || !Number.isFinite(kg) || kg < H.LIMITS.kgMin || kg > H.LIMITS.kgMax) {
      host.showToast(unit === "jin" ? "体重需在 40–800 斤之间" : "体重需在 20–400 kg 之间");
      return;
    }
    const existing = state.weights.find((item) => item.date === key);
    const nowIso = new Date().toISOString();
    const record = {
      id: existing ? existing.id : Core.makeId("w"),
      date: key,
      kg,
      note: $("weightNote").value.trim().slice(0, H.LIMITS.note),
      createdAt: existing ? existing.createdAt : nowIso,
      updatedAt: nowIso,
    };
    const next = clone(state);
    next.weights = next.weights.filter((item) => item.date !== key).concat(record);
    closeActiveSheet();
    commitWithUndo(next, existing ? "体重已更新" : `已记下 ${H.formatWeight(kg, unit)}`);
  }

  function deleteWeight() {
    const id = view.editingWeightId;
    if (!id || !window.confirm("确定删除这天的体重吗？删除后可在 8 秒内撤销。")) return;
    const next = clone(state);
    next.weights = next.weights.filter((item) => item.id !== id);
    closeActiveSheet();
    commitWithUndo(next, "体重记录已删除");
  }

  function reflectInterval() {
    const value = Number($("planInterval").value);
    all("#intervalChips [data-days]").forEach((button) => {
      button.classList.toggle("active", Number(button.dataset.days) === value);
    });
    // With an injection on record the next date follows from it, so keep the
    // read-only date in step with the interval being edited.
    const last = H.lastInjection(state);
    if (last && Number.isInteger(value) && value >= H.LIMITS.intervalMin && value <= H.LIMITS.intervalMax) {
      $("planStart").value = H.addDaysToKey(Core.toLocalDateKey(last.occurredAt), value);
    }
  }

  function reflectPlanReminder() {
    const available = nativeReminderAvailable();
    const toggle = $("planReminder");
    toggle.disabled = !available;
    if (!available) toggle.checked = false;
    $("planReminderTime").disabled = !available || !toggle.checked;
    setText("planReminderHint", available ? "到下一针那天，本机发一条通知" : "网页版没有提醒，请使用 Android 版");
  }

  function hoursLabel(hours) {
    return hours >= 48 ? `约 ${Math.round((hours / 24) * 10) / 10} 天` : `${hours} 小时`;
  }

  function renderPkPresets() {
    const root = $("pkPresets");
    if (!root) return;
    const halfLife = Number($("planHalfLife").value);
    const tmax = Number($("planTmax").value);
    const empty = !$("planHalfLife").value && !$("planTmax").value;
    const named = H.matchPkPreset($("planName").value);
    root.innerHTML = H.PK_PRESETS.map((preset) => {
      const active = preset.halfLifeHours === halfLife && preset.tmaxHours === tmax;
      return `<button type="button" class="${active ? "active" : ""}${named === preset ? " suggested" : ""}" data-action="health-pick-pk" data-preset="${preset.id}">${esc(preset.name)} · ${esc(hoursLabel(preset.halfLifeHours))}</button>`;
    }).join("") + `<button type="button" class="${empty ? "active" : ""}" data-action="health-pick-pk" data-preset="">不估算</button>`;
    const pk = H.cleanPkParams(halfLife, tmax);
    setText("pkHint", pk
      ? `半衰期 ${hoursLabel(pk.halfLifeHours)}，达峰 ${hoursLabel(pk.tmaxHours)}。预设为说明书公开参考值，个体差异很大。`
      : "预设为说明书公开参考值，个体差异很大，可按说明书修改。");
  }

  function pickPkPreset(id) {
    const preset = H.PK_PRESETS.find((item) => item.id === id);
    $("planHalfLife").value = preset ? String(preset.halfLifeHours) : "";
    $("planTmax").value = preset ? String(preset.tmaxHours) : "";
    renderPkPresets();
  }

  function parsePkParams() {
    const rawHalfLife = $("planHalfLife").value.trim();
    const rawTmax = $("planTmax").value.trim();
    if (!rawHalfLife && !rawTmax) return { ok: true, value: null };
    const pk = H.cleanPkParams(Number(rawHalfLife), Number(rawTmax));
    if (!pk) {
      host.showToast("半衰期需为 1–2000 小时，达峰时间需短于半衰期的 1.4 倍");
      return { ok: false };
    }
    return { ok: true, value: pk };
  }

  function openPlan() {
    const plan = state.plan;
    const last = H.lastInjection(state);
    $("planName").value = plan ? plan.name : (last ? last.name : "");
    $("planDose").value = plan && plan.doseValue != null ? String(plan.doseValue) : "";
    view.planUnit = plan ? plan.doseUnit : (last ? last.doseUnit : "mg");
    $("planInterval").value = String(plan ? plan.intervalDays : 7);
    const next = plan ? H.nextDose(state, new Date()) : null;
    $("planStart").value = plan ? (next ? next.dueKey : plan.startDate) : todayKey();
    setText("planStartLabel", last ? "下一针日期（按上次注射推算）" : "下一针日期");
    $("planStart").disabled = Boolean(last);
    $("planReminder").checked = Boolean(plan && plan.reminderEnabled);
    $("planReminderTime").value = plan ? plan.reminderTime : "09:00";
    $("planHalfLife").value = plan && plan.halfLifeHours != null ? String(plan.halfLifeHours) : "";
    $("planTmax").value = plan && plan.tmaxHours != null ? String(plan.tmaxHours) : "";
    renderPkPresets();
    setText("planSheetTitle", plan ? "调整用药计划" : "设置用药计划");
    $("planEditActions").classList.toggle("hidden", !plan);
    renderUnitPicker("planUnits", view.planUnit, "health-pick-plan-unit");
    reflectInterval();
    reflectPlanReminder();
    openSheet("planSheet");
  }

  function savePlan() {
    const name = $("planName").value.trim();
    if (!name || name.length > H.LIMITS.name) {
      host.showToast("请填写药物名称（最多 40 字）");
      return;
    }
    const interval = Number($("planInterval").value);
    if (!Number.isInteger(interval) || interval < H.LIMITS.intervalMin || interval > H.LIMITS.intervalMax) {
      host.showToast("间隔需为 1–60 天的整数");
      return;
    }
    const dose = parseDose("planDose");
    if (!dose.ok) return;
    const last = H.lastInjection(state);
    const startDate = last ? H.addDaysToKey(Core.toLocalDateKey(last.occurredAt), interval) : $("planStart").value;
    if (!H.isDateKey(startDate)) {
      host.showToast("请选择下一针日期");
      return;
    }
    const reminderTime = $("planReminderTime").value;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(reminderTime)) {
      host.showToast("请选择有效的提醒时间");
      return;
    }
    const pk = parsePkParams();
    if (!pk.ok) return;
    const reminderEnabled = nativeReminderAvailable() && $("planReminder").checked;
    const turnedOn = reminderEnabled && !(state.plan && state.plan.reminderEnabled);
    const next = clone(state);
    next.plan = {
      name,
      doseValue: dose.value,
      doseUnit: view.planUnit,
      intervalDays: interval,
      startDate,
      reminderEnabled,
      reminderTime,
      ...(pk.value || {}),
    };
    if (!commit(next)) return;
    closeActiveSheet();
    syncDoseReminder();
    host.renderAll();
    const due = H.nextDose(state, new Date());
    host.showToast(turnedOn && due
      ? `计划已保存，将在 ${dateLabel(due.dueKey)} ${reminderTime} 提醒`
      : "用药计划已保存");
  }

  function deletePlan() {
    if (!window.confirm("删除用药计划吗？已有的注射和体重记录都会保留。")) return;
    const next = clone(state);
    next.plan = null;
    closeActiveSheet();
    commitWithUndo(next, "用药计划已删除");
  }

  // ---- Backup ---------------------------------------------------------------

  function exportBackup() {
    if (!state.injections.length && !state.weights.length && !state.plan) {
      host.showToast("还没有健康数据需要导出");
      return;
    }
    host.exportJson(JSON.stringify(H.makeBackup(state), null, 2), "health");
  }

  function exportRecovery() {
    const raw = store.recoveryRaw();
    if (!raw) return;
    const json = JSON.stringify({
      app: "week168-health-recovery",
      version: 1,
      exportedAt: new Date().toISOString(),
      note: "这是异常健康数据的原始副本，请勿直接作为普通备份导入。",
      raw,
    }, null, 2);
    view.recoveryExportPending = true;
    if (host.exportJson(json, "health-recovery") === "downloaded") {
      view.recoveryExportPending = false;
      store.markRecoveryExported();
    }
  }

  function importBackup(raw) {
    const result = H.validateBackup(raw);
    if (!result.ok) {
      host.showToast(`无法导入：${result.message}`);
      return;
    }
    const message = `健康备份包含 ${result.injections} 条注射、${result.weights} 条体重记录，将替换当前的 ${state.injections.length} 条注射和 ${state.weights.length} 条体重。\n\n时间记录不受影响。确认导入吗？`;
    if (!window.confirm(message)) {
      host.showToast("已取消导入，健康数据没有变化");
      return;
    }
    const next = result.state;
    next.enabled = true;
    if (!commit(next)) return;
    syncDoseReminder();
    host.renderAll();
    host.showToast(`已恢复 ${result.injections} 条注射、${result.weights} 条体重`);
  }

  function clearAll() {
    const total = state.injections.length + state.weights.length;
    if (!total && !state.plan) {
      host.showToast("目前没有健康数据需要清空");
      return;
    }
    if (!window.confirm(`将删除用药计划、${state.injections.length} 条注射和 ${state.weights.length} 条体重记录。时间记录不受影响。\n\n要继续吗？`)) return;
    if (!window.confirm("请再次确认：真的要清空全部健康数据吗？")) return;
    const next = H.defaultHealth();
    next.enabled = state.enabled;
    next.settings = clone(state.settings);
    commitWithUndo(next, "健康数据已清空");
  }

  function setWeightUnit(unit) {
    if (!H.WEIGHT_UNITS.includes(unit) || unit === state.settings.weightUnit) return;
    const next = clone(state);
    next.settings.weightUnit = unit;
    if (commit(next)) host.renderAll();
  }

  // ---- Wiring ---------------------------------------------------------------

  function handleAction(action, target) {
    switch (action) {
      case "health-open": host.navigate("health"); break;
      case "health-back": host.navigate("today"); break;
      case "health-close-sheet": closeActiveSheet(); break;
      case "health-new-injection": openInjection(); break;
      case "health-edit-injection": openInjection(target.dataset.id); break;
      case "health-save-injection": saveInjection(); break;
      case "health-delete-injection": deleteInjection(); break;
      case "health-pick-site":
        view.injectionSite = view.injectionSite === target.dataset.site ? "" : target.dataset.site;
        renderSitePicker();
        break;
      case "health-pick-dose-unit":
        view.injectionUnit = target.dataset.unit;
        renderUnitPicker("injectionUnits", view.injectionUnit, action);
        break;
      case "health-pick-plan-unit":
        view.planUnit = target.dataset.unit;
        renderUnitPicker("planUnits", view.planUnit, action);
        break;
      case "health-new-weight": openWeight(); break;
      case "health-edit-weight": openWeight(target.dataset.id); break;
      case "health-weight-step": stepWeight(Number(target.dataset.step) || 0); break;
      case "health-save-weight": saveWeight(); break;
      case "health-delete-weight": deleteWeight(); break;
      case "health-weight-range":
        view.weightRange = Number(target.dataset.days) || 0;
        renderWeightCard();
        break;
      case "health-weight-unit": setWeightUnit(target.dataset.unit); break;
      case "health-open-plan": openPlan(); break;
      case "health-pick-pk": pickPkPreset(target.dataset.preset); break;
      case "health-pick-interval":
        $("planInterval").value = target.dataset.days;
        reflectInterval();
        break;
      case "health-save-plan": savePlan(); break;
      case "health-delete-plan": deletePlan(); break;
      case "health-toggle-injections":
        view.showAllInjections = !view.showAllInjections;
        renderInjectionList();
        break;
      case "health-export": exportBackup(); break;
      case "health-import": host.requestImport(); break;
      case "health-export-recovery": exportRecovery(); break;
      case "health-clear": clearAll(); break;
      default: return false;
    }
    return true;
  }

  function installEvents() {
    $("healthEnabled").addEventListener("change", (event) => setEnabled(event.target.checked));
    SHEETS.forEach(([sheetId, backdropId]) => {
      $(backdropId).addEventListener("click", () => host.setSheetOpen(sheetId, backdropId, false));
    });
    ["injectionForm", "weightForm", "planForm"].forEach((id) => {
      $(id).addEventListener("submit", (event) => event.preventDefault());
    });
    $("weightDate").addEventListener("change", (event) => {
      if (H.isDateKey(event.target.value)) fillWeightForDate(event.target.value);
    });
    $("planInterval").addEventListener("input", reflectInterval);
    ["planHalfLife", "planTmax", "planName"].forEach((id) => $(id).addEventListener("input", renderPkPresets));
    $("planReminder").addEventListener("change", reflectPlanReminder);
    window.addEventListener("resize", () => {
      window.clearTimeout(view.resizeTimer);
      view.resizeTimer = window.setTimeout(() => {
        if (host.currentView() !== "health") return;
        renderWeightChart();
        renderLevelCard();
      }, 150);
    });
    window.addEventListener("android-dose-reminder-updated", (event) => {
      const detail = String(event.detail || "");
      if (detail === "off") turnReminderOff("通知未开启，注射日提醒已关闭");
      else if (detail === "error") turnReminderOff("提醒设置无效，已保持关闭");
    });
    window.addEventListener("android-export-complete", () => {
      if (!view.recoveryExportPending) return;
      view.recoveryExportPending = false;
      store.markRecoveryExported();
    });
    ["android-export-error", "android-export-cancelled"].forEach((name) => {
      window.addEventListener(name, () => { view.recoveryExportPending = false; });
    });
  }

  function mount(hostApi) {
    host = hostApi;
    let storage;
    try {
      storage = window.localStorage;
    } catch (error) {
      storage = { getItem() { throw error; }, setItem() { throw error; } };
    }
    store = H.createStore(storage);
    state = store.load();
    installEvents();
    readNativeDoseState();
  }

  window.Week168HealthUI = {
    mount,
    render,
    renderTodayCard,
    renderSettings,
    handleAction,
    activeSheet,
    closeActiveSheet,
    importBackup,
    isHealthBackup: H.isHealthBackup,
    isEnabled: () => state.enabled,
    startupWarning: () => (store ? store.warning() : ""),
  };
})();
