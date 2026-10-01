(function () {
  "use strict";

  const Core = window.Time168Core;
  if (!Core) throw new Error("Time168Core is required");
  // Generated from editions/<id>.json at build time (see scripts/edition.js).
  const Edition = window.Time168Edition;
  if (!Edition) throw new Error("Time168Edition is required");
  const FEATURES = Edition.features;
  // Optional edition-specific weekly report (editions/<id>/report.js), bundled
  // into edition.js at build time. Without it the neutral report is used.
  const ReportExt = window.Time168ReportExtension || null;
  const TextImport = window.Time168TextImport;
  const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";
  const DEEPSEEK_MODEL = "deepseek-flash";

  const STORAGE_KEY = "time168.state.v1";
  const RECOVERY_KEY = "time168.recovery.v1";
  // Browser-only bookkeeping, kept outside the state so backups stay unchanged.
  const LAST_BACKUP_KEY = "time168.lastBackup.v1";
  const LAST_NUDGE_KEY = "time168.lastBackupNudge.v1";
  const BACKUP_NUDGE_DAYS = 14;
  // Unsent text for "用文字补记一天" survives the WebView being killed in the
  // background. It stays on this device and never enters backups.
  const AI_DRAFT_KEY = "time168.aiDraft.v1";
  const AI_DRAFT_MAX_AGE_DAYS = 7;
  const DATA_VERSION = 1;
  const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
  const CATEGORY_COLORS = [
    "#5b7fa3", "#a56d4e", "#6d8f83", "#b39458",
    "#7068ad", "#3f9272", "#398a9d", "#bc785f",
    "#b2607d", "#9b714f", "#7a7e8d", "#65816d",
  ];
  const DEFAULT_CATEGORIES = Edition.categories.map((item) => ({ ...item, custom: false }));
  const MAX_CATEGORIES = 200;
  const RESERVED_CATEGORY_IDS = new Set(["__proto__", "prototype", "constructor"]);

  const ui = {
    view: "today",
    selectedDate: Core.toLocalDateKey(new Date()),
    selectedWeek: Core.weekKey(new Date()),
    editingId: "",
    selectedCategory: "",
    selectedColor: CATEGORY_COLORS[0],
    undo: null,
    toastTimer: 0,
    shouldScrollTimeline: true,
    quickPanelVisible: true,
    importPending: false,
    rangeSelectMode: false,
    sheetReturnFocus: Object.create(null),
    lastTodayKey: Core.toLocalDateKey(new Date()),
    dayBoundaryTimer: 0,
    recoveryExportPending: false,
    aiDrafts: [],
    aiUnresolved: [],
    aiPending: false,
    aiRequestId: "",
    aiStartedAt: 0,
    aiElapsedTimer: 0,
    aiLastDurationSeconds: 0,
    aiCustomEndpoint: "",
    aiCustomModel: "",
    aiDeepseekModel: DEEPSEEK_MODEL,
    aiProfiles: [],
    aiActiveProfileId: "",
    aiEditingProfileId: "",
    aiEditorOpen: false,
    aiTestingId: "",
  };

  const $ = (id) => document.getElementById(id);
  const all = (selector, root) => Array.from((root || document).querySelectorAll(selector));
  const nativeBridge = () => window.AndroidBridge || null;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function defaultState() {
    return {
      version: DATA_VERSION,
      entries: [],
      categories: clone(DEFAULT_CATEGORIES),
      settings: { theme: "system", reminderEnabled: false, reminderTime: "22:00" },
      updatedAt: new Date().toISOString(),
    };
  }

  function safeColor(value, fallback) {
    return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : (fallback || "#65816d");
  }

  function cleanCategory(category, custom) {
    if (!category || typeof category !== "object") return null;
    const id = String(category.id || "").trim().slice(0, 80);
    const name = String(category.name || "").trim().slice(0, 24);
    if (!id || !name || !/^[a-zA-Z0-9_-]+$/.test(id)
        || RESERVED_CATEGORY_IDS.has(id.toLocaleLowerCase())) return null;
    return {
      id,
      name,
      color: safeColor(category.color),
      custom: Boolean(custom),
      sleep: Boolean(category.sleep),
      lowQuality: Boolean(category.lowQuality),
    };
  }

  function normalizeCategories(input) {
    const result = clone(DEFAULT_CATEGORIES);
    const ids = new Set(result.map((item) => item.id));
    (Array.isArray(input) ? input : []).forEach((item) => {
      if (!item || !item.custom) return;
      const category = cleanCategory(item, true);
      if (category && !ids.has(category.id)) {
        ids.add(category.id);
        result.push(category);
      }
    });
    return result;
  }

  function normalizeSettings(input) {
    const source = input && typeof input === "object" ? input : {};
    const theme = ["system", "light", "dark"].includes(source.theme) ? source.theme : "system";
    const reminderTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(source.reminderTime || ""))
      ? String(source.reminderTime) : "22:00";
    return { theme, reminderEnabled: Boolean(source.reminderEnabled), reminderTime };
  }

  function normalizeState(input) {
    const clean = defaultState();
    if (!input || typeof input !== "object") return clean;
    clean.categories = normalizeCategories(input.categories);
    const categoryIds = new Set(clean.categories.map((item) => item.id));
    clean.entries = Core.normalizeEntries(input.entries).filter((entry) => categoryIds.has(entry.categoryId));
    clean.settings = normalizeSettings(input.settings);
    clean.updatedAt = typeof input.updatedAt === "string" ? input.updatedAt : clean.updatedAt;
    return clean;
  }

  let needsInitialPersist = false;
  let startupWarning = "";
  let preservedRawState = "";
  let recoveryProtected = false;

  try {
    preservedRawState = localStorage.getItem(RECOVERY_KEY) || "";
    recoveryProtected = Boolean(preservedRawState);
  } catch (error) { /* Storage availability is checked again when persisting. */ }

  function preserveDamagedState(raw, message) {
    preservedRawState = String(raw || "");
    startupWarning = message;
    recoveryProtected = false;
    if (!preservedRawState) return;
    try {
      localStorage.setItem(RECOVERY_KEY, preservedRawState);
      recoveryProtected = true;
    } catch (error) { /* Keep the only readable copy in memory and block overwrites. */ }
  }

  function isCanonicalIsoString(value) {
    if (typeof value !== "string") return false;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  }

  function storedStateIsCanonical(source, normalized) {
    if (!isCanonicalIsoString(source.updatedAt) || source.updatedAt !== normalized.updatedAt) return false;
    if (typeof source.settings.theme !== "string"
        || typeof source.settings.reminderEnabled !== "boolean"
        || typeof source.settings.reminderTime !== "string"
        || source.settings.theme !== normalized.settings.theme
        || source.settings.reminderEnabled !== normalized.settings.reminderEnabled
        || source.settings.reminderTime !== normalized.settings.reminderTime) return false;
    if (source.categories.length !== normalized.categories.length
        || source.entries.length !== normalized.entries.length) return false;
    for (let index = 0; index < source.categories.length; index += 1) {
      const raw = source.categories[index];
      const clean = normalized.categories[index];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)
          || typeof raw.id !== "string" || typeof raw.name !== "string"
          || typeof raw.color !== "string" || typeof raw.custom !== "boolean"
          || (Object.prototype.hasOwnProperty.call(raw, "sleep") && typeof raw.sleep !== "boolean")
          || (Object.prototype.hasOwnProperty.call(raw, "lowQuality") && typeof raw.lowQuality !== "boolean")
          || raw.id !== clean.id || raw.name !== clean.name || raw.color !== clean.color
          || raw.custom !== clean.custom || Boolean(raw.sleep) !== Boolean(clean.sleep)
          || Boolean(raw.lowQuality) !== Boolean(clean.lowQuality)) return false;
    }
    const stringFields = ["id", "start", "end", "categoryId", "content", "location", "note", "createdAt", "updatedAt"];
    for (let index = 0; index < source.entries.length; index += 1) {
      const raw = source.entries[index];
      const clean = normalized.entries[index];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)
          || !Number.isInteger(raw.energy) || !Number.isInteger(raw.mood)
          || raw.energy < 0 || raw.energy > 5 || raw.mood < 0 || raw.mood > 5
          || !isCanonicalIsoString(raw.start) || !isCanonicalIsoString(raw.end)
          || !isCanonicalIsoString(raw.createdAt) || !isCanonicalIsoString(raw.updatedAt)
          || raw.energy !== clean.energy || raw.mood !== clean.mood) return false;
      if (stringFields.some((field) => typeof raw[field] !== "string" || raw[field] !== clean[field])) return false;
    }
    return true;
  }

  function loadState() {
    let raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      startupWarning = "暂时无法读取本机存储；本次修改可能无法保存";
      return defaultState();
    }
    if (!raw) {
      needsInitialPersist = true;
      return defaultState();
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      preserveDamagedState(raw, "发现本机数据异常，原始内容已保护；可在设置中导出抢救副本");
      return defaultState();
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
        || parsed.version !== DATA_VERSION
        || !Array.isArray(parsed.entries) || !Array.isArray(parsed.categories)
        || !parsed.settings || typeof parsed.settings !== "object" || Array.isArray(parsed.settings)) {
      preserveDamagedState(raw, "发现无法识别的本机数据，原始内容已保护；可在设置中导出抢救副本");
      return defaultState();
    }
    const normalized = normalizeState(parsed);
    if (!storedStateIsCanonical(parsed, normalized)) {
      preserveDamagedState(raw, "部分本机数据格式异常，已保护原始副本并尽量恢复可用内容");
    }
    return normalized;
  }

  let state = loadState();

  function persist() {
    if (preservedRawState && !recoveryProtected) {
      showToast("为避免覆盖异常原数据，请先在设置中导出抢救副本");
      return false;
    }
    const previousUpdatedAt = state.updatedAt;
    state.version = DATA_VERSION;
    state.updatedAt = new Date().toISOString();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (error) {
      state.updatedAt = previousUpdatedAt;
      showToast("设备存储空间不足，这次修改未能保存");
      return false;
    }
  }

  function categoryById(id) {
    return state.categories.find((category) => category.id === id)
      || { id: "unknown", name: "未知分类", color: "#7a7e8d" };
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function setText(id, value) {
    const element = $(id);
    if (element) element.textContent = value;
  }

  function formatMonthDay(value) {
    const date = Core.asDate(value);
    return date ? `${date.getMonth() + 1}月${date.getDate()}日` : "";
  }

  function formatWeekRange(value) {
    const range = Core.weekRange(value);
    const end = Core.addDays(range.end, -1);
    if (range.start.getFullYear() !== end.getFullYear()) {
      return `${range.start.getFullYear()}年${formatMonthDay(range.start)} – ${end.getFullYear()}年${formatMonthDay(end)}`;
    }
    return `${range.start.getFullYear()}年 ${formatMonthDay(range.start)} – ${formatMonthDay(end)}`;
  }

  function formatHours(minutes) {
    const rounded = Math.round((Number(minutes) || 0) / 15) * 15;
    if (!rounded) return "0小时";
    const hours = Math.floor(rounded / 60);
    const rest = rounded % 60;
    if (!hours) return `${rest}分钟`;
    return rest ? `${hours}小时${rest}分` : `${hours}小时`;
  }

  function formatHourNumber(minutes) {
    return String(Math.round((Number(minutes) || 0) / 15) / 4).replace(/\.0$/, "");
  }

  function formatPercentage(ratio) {
    return Math.round((Number(ratio) || 0) * 1000) / 10;
  }

  function isSameDate(a, b) {
    return Core.toLocalDateKey(a) === Core.toLocalDateKey(b);
  }

  function showToast(message, undoFn) {
    const toast = $("toast");
    if (!toast) return;
    window.clearTimeout(ui.toastTimer);
    toast.replaceChildren();
    const label = document.createElement("span");
    label.textContent = String(message || "");
    toast.appendChild(label);
    if (undoFn) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "撤销";
      button.style.cssText = "margin-left:12px;border:0;background:transparent;color:inherit;font-weight:800;text-decoration:underline;";
      button.addEventListener("click", () => {
        const action = ui.undo;
        ui.undo = null;
        toast.classList.remove("show");
        if (action) action();
      });
      toast.appendChild(button);
      ui.undo = undoFn;
    } else {
      ui.undo = null;
    }
    toast.classList.add("show");
    ui.toastTimer = window.setTimeout(() => {
      toast.classList.remove("show");
      ui.undo = null;
    }, undoFn ? 8000 : 3000);
  }

  function withEntryUndo(message, beforeEntries) {
    showToast(message, () => {
      const currentEntries = clone(state.entries);
      state.entries = clone(beforeEntries);
      if (!persist()) {
        state.entries = currentEntries;
        renderAll();
        return;
      }
      renderAll();
      showToast("已撤销");
    });
  }

  function effectiveTheme() {
    if (state.settings.theme !== "system") return state.settings.theme;
    // The Android shell uses a light window theme, so the WebView's media
    // query never reports dark there; ask the shell for the system theme.
    const bridge = nativeBridge();
    if (bridge && typeof bridge.isSystemDark === "function") {
      try { return bridge.isSystemDark() ? "dark" : "light"; } catch (error) { /* Fall back to the media query. */ }
    }
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function applyTheme() {
    const theme = effectiveTheme();
    document.documentElement.dataset.theme = theme;
    all("[data-theme-choice]").forEach((button) => {
      const active = button.dataset.themeChoice === state.settings.theme;
      button.classList.toggle("active", active);
      button.setAttribute("aria-checked", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === "dark" ? "#101613" : "#f6f5f1";
    const bridge = nativeBridge();
    if (bridge && typeof bridge.setSystemTheme === "function") {
      try { bridge.setSystemTheme(theme === "dark"); } catch (error) { /* Web fallback remains active. */ }
    }
  }

  function navigate(view) {
    if (!["today", "week", "report", "history", "settings"].includes(view)) return;
    if (view !== "today" && ui.rangeSelectMode) setRangeSelectMode(false, false);
    ui.view = view;
    all(".view").forEach((element) => element.classList.toggle("active", element.dataset.view === view));
    all("[data-nav]").forEach((button) => {
      const active = button.dataset.nav === view;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    updateFloatingAddVisibility();
    const subtitles = {
      today: "本周，慢慢记录", week: "七天的时间地图", report: "看见，不评判",
      history: "每一周都算数", settings: "数据只在本机",
    };
    setText("headerSubtitle", subtitles[view]);
    // A hidden view loses its inner scroll position, so re-anchor the timeline.
    if (view === "today") ui.shouldScrollTimeline = true;
    if (view === "today") renderToday();
    if (view === "week") renderWeek();
    if (view === "report") renderReport();
    if (view === "history") renderHistory();
    if (view === "settings") renderSettings();
    window.scrollTo(0, 0);
  }

  function updateFloatingAddVisibility() {
    const floatingAdd = $("floatingAdd");
    const hidden = ui.view !== "today" || ui.quickPanelVisible;
    floatingAdd.classList.toggle("hide-for-view", hidden);
    floatingAdd.hidden = hidden;
    floatingAdd.disabled = hidden;
    floatingAdd.setAttribute("aria-hidden", String(hidden));
  }

  function setSelectedWeek(value, selectDay) {
    const start = Core.startOfWeek(value);
    ui.selectedWeek = Core.toLocalDateKey(start);
    if (selectDay !== false) {
      const today = new Date();
      ui.selectedDate = Core.weekKey(today) === ui.selectedWeek
        ? Core.toLocalDateKey(today) : ui.selectedWeek;
    }
    ui.shouldScrollTimeline = true;
  }

  function goCurrentWeek(openToday) {
    setSelectedWeek(new Date());
    if (openToday) navigate("today");
    else renderAll();
  }

  function updateWeekChrome() {
    const current = ui.selectedWeek === Core.weekKey(new Date());
    setText("weekButtonText", current ? "本周" : formatMonthDay(Core.fromLocalDateKey(ui.selectedWeek)));
    setText("weekRangeLabel", current ? `本周 · ${formatWeekRange(ui.selectedWeek)}` : formatWeekRange(ui.selectedWeek));
    setText("weekRangeMeta", current ? "正在查看本周" : "点中间回到本周");
  }

  function renderDayStrip() {
    const root = $("dayStrip");
    if (!root) return;
    const start = Core.fromLocalDateKey(ui.selectedWeek);
    root.replaceChildren();
    for (let index = 0; index < 7; index += 1) {
      const date = Core.addDays(start, index);
      const key = Core.toLocalDateKey(date);
      const end = Core.addDays(date, 1);
      const hasData = Core.entriesInRange(state.entries, date, end).length > 0;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "day-chip";
      button.dataset.action = "select-day";
      button.dataset.date = key;
      button.classList.toggle("selected", key === ui.selectedDate);
      button.classList.toggle("today", key === Core.toLocalDateKey(new Date()));
      button.classList.toggle("has-data", hasData);
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(key === ui.selectedDate));
      button.setAttribute("aria-label", `${formatMonthDay(date)}，周${WEEKDAYS[index]}${hasData ? "，有记录" : ""}`);
      button.innerHTML = `<span>${index > 4 ? "周" : ""}${WEEKDAYS[index]}</span><strong>${date.getDate()}</strong><i></i>`;
      root.appendChild(button);
    }
  }

  function dayIntervals(dateStart) {
    const dateEnd = Core.addDays(dateStart, 1);
    return Core.entriesInRange(state.entries, dateStart, dateEnd).map((entry) => ({
      start: new Date(Math.max(new Date(entry.start), dateStart)),
      end: new Date(Math.min(new Date(entry.end), dateEnd)),
    }));
  }

  function renderTimeline() {
    const canvas = $("timelineCanvas");
    if (!canvas) return;
    const dateStart = Core.fromLocalDateKey(ui.selectedDate);
    const dateEnd = Core.addDays(dateStart, 1);
    const entries = Core.entriesInRange(state.entries, dateStart, dateEnd)
      .sort((a, b) => new Date(a.start) - new Date(b.start));
    canvas.replaceChildren();

    for (let hour = 0; hour < 24; hour += 1) {
      const row = document.createElement("div");
      row.className = "timeline-hour";
      row.style.top = `${hour * 62}px`;
      row.innerHTML = `<span>${String(hour).padStart(2, "0")}:00</span>`;
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = "new-at";
      button.dataset.date = ui.selectedDate;
      button.dataset.hour = String(hour);
      button.setAttribute("aria-label", `${formatMonthDay(dateStart)} ${hour}点添加记录`);
      row.appendChild(button);
      canvas.appendChild(row);
    }

    // Untracked time up to now is shown as a gentle "待补" block that opens
    // the entry sheet with the exact gap prefilled.
    const gapLimit = new Date(Math.min(dateEnd, Core.roundToQuarter(new Date(), "floor")));
    const fillableGaps = [];
    Core.subtractIntervals(dateStart, gapLimit, entries).forEach((gap) => {
      // A single entry must stay shorter than a full day. Show a fully
      // untracked day as two halves so each label matches its prefilled range.
      if (Core.durationMinutes(gap.start, gap.end) >= Core.DAY_MINUTES) {
        const midpoint = Core.addMinutes(gap.start, Core.DAY_MINUTES / 2);
        fillableGaps.push({ start: gap.start, end: midpoint }, { start: midpoint, end: gap.end });
      } else {
        fillableGaps.push(gap);
      }
    });
    fillableGaps.forEach((gap) => {
      const gapStart = Core.durationMinutes(dateStart, gap.start);
      const gapMinutes = Core.durationMinutes(gap.start, gap.end);
      if (gapMinutes < 15) return;
      const gapEnd = gapStart + gapMinutes;
      const range = `${Core.minutesToTime(gapStart)}–${gapEnd >= Core.DAY_MINUTES ? "24:00" : Core.minutesToTime(gapEnd)}`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "timeline-gap";
      button.dataset.action = "fill-gap";
      button.dataset.start = String(gapStart);
      button.dataset.end = String(gapEnd);
      button.style.top = `${(gapStart / 60) * 62 + 2}px`;
      button.style.height = `${Math.max(22, (gapMinutes / 60) * 62 - 4)}px`;
      button.innerHTML = gapMinutes >= 45
        ? `<strong>待补 ${range}</strong><span>${Core.formatDuration(gapMinutes, true)} · 点此补记</span>`
        : `<strong>待补 ${range}</strong>`;
      button.setAttribute("aria-label", `待补 ${range}，点按补记`);
      canvas.appendChild(button);
    });

    entries.forEach((entry) => {
      const clippedStart = new Date(Math.max(new Date(entry.start), dateStart));
      const clippedEnd = new Date(Math.min(new Date(entry.end), dateEnd));
      const startMinutes = Core.durationMinutes(dateStart, clippedStart);
      const duration = Core.durationMinutes(clippedStart, clippedEnd);
      if (!duration) return;
      const category = categoryById(entry.categoryId);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "timeline-entry";
      button.dataset.action = "edit-entry";
      button.dataset.id = entry.id;
      button.style.setProperty("--entry-color", category.color);
      button.style.top = `${(startMinutes / 60) * 62 + 2}px`;
      button.style.height = `${Math.max(22, (duration / 60) * 62 - 4)}px`;
      const startLabel = Core.minutesToTime(Core.minutesOfDay(new Date(entry.start)));
      const endLabel = Core.minutesToTime(Core.minutesOfDay(new Date(entry.end)));
      const crosses = Core.toLocalDateKey(entry.start) !== Core.toLocalDateKey(entry.end);
      const timeLabel = `${startLabel}–${endLabel}${crosses ? " 次日" : ""}`;
      button.innerHTML = entry.content
        ? `<strong>${escapeHtml(entry.content)}</strong><span>${timeLabel} · ${escapeHtml(category.name)}</span>`
        : `<strong>${escapeHtml(category.name)}</strong><span>${timeLabel}</span>`;
      button.setAttribute("aria-label", `${category.name}，${startLabel}到${endLabel}，点按编辑`);
      canvas.appendChild(button);
    });

    if (isSameDate(dateStart, new Date())) {
      const now = new Date();
      const line = document.createElement("div");
      line.className = "now-line";
      line.style.top = `${(Core.minutesOfDay(now) / 60) * 62}px`;
      canvas.appendChild(line);
    }

    const tracked = Core.intervalUnionMinutes(dayIntervals(dateStart));
    setText("dayTracked", formatHours(tracked));
    setText("timelineHeading", `${formatMonthDay(dateStart)} · 周${WEEKDAYS[(dateStart.getDay() + 6) % 7]}`);
    if (ui.shouldScrollTimeline) {
      ui.shouldScrollTimeline = false;
      window.requestAnimationFrame(() => {
        const targetHour = isSameDate(dateStart, new Date())
          ? Math.max(0, new Date().getHours() - 2) : 7;
        $("timelineScroll").scrollTop = targetHour * 62;
      });
    }
    reflectRangeSelectMode();
  }

  function renderToday() {
    updateWeekChrome();
    renderDayStrip();
    renderTimeline();
    const date = Core.fromLocalDateKey(ui.selectedDate);
    const isToday = isSameDate(date, new Date());
    setText("todayEyebrow", isToday ? "今天" : `${formatMonthDay(date)} · 周${WEEKDAYS[(date.getDay() + 6) % 7]}`);
    const dayTracked = Core.intervalUnionMinutes(dayIntervals(date));
    setText("todaySummary", `${isToday ? "今天" : "这天"}已记 ${formatHours(dayTracked)} · 空白只是待补`);
    const stats = weekStats(ui.selectedWeek);
    setText("weekProgressNumber", String(Math.round(stats.trackedMinutes / 60)));
    $("weekProgressOrbit").style.setProperty("--progress", `${Math.min(360, stats.trackedMinutes / Core.WEEK_MINUTES * 360)}deg`);
    const latest = state.entries.slice().sort((a, b) => new Date(b.end) - new Date(a.end))[0];
    $("continueButton").disabled = !latest;
    setText("continueButton", latest ? `接着上一条 · ${categoryById(latest.categoryId).name}` : "接着上一条");
  }

  function categoryTotalsSorted(stats) {
    return Object.entries(stats.totals)
      .filter(([, minutes]) => minutes > 0)
      .sort((a, b) => b[1] - a[1]);
  }

  function renderCategoryBars(rootId, stats) {
    const root = $(rootId);
    if (!root) return;
    const totals = categoryTotalsSorted(stats);
    if (!totals.length) {
      root.innerHTML = '<div class="empty-card">还没有记录。先记下一段真实的时间吧。</div>';
      return;
    }
    const max = Math.max(...totals.map((item) => item[1]), 1);
    root.innerHTML = totals.map(([id, minutes]) => {
      const category = categoryById(id);
      const width = Math.max(2, minutes / max * 100);
      return `<div class="bar-row" style="--bar-color:${safeColor(category.color)};--bar-width:${width}%"><span class="bar-label"><i></i>${escapeHtml(category.name)}</span><span class="bar-track"><span class="bar-fill"></span></span><span class="bar-value">${formatHours(minutes)}</span></div>`;
    }).join("");
  }

  function renderHeatmap(stats) {
    const root = $("heatmap");
    const legend = $("heatmapLegend");
    if (!root || !legend) return;
    root.replaceChildren();
    const empty = document.createElement("span");
    empty.className = "heatmap-label";
    root.appendChild(empty);
    for (let day = 0; day < 7; day += 1) {
      const label = document.createElement("span");
      label.className = "heatmap-label heatmap-day-label";
      label.textContent = WEEKDAYS[day];
      root.appendChild(label);
    }
    const weekStart = Core.fromLocalDateKey(ui.selectedWeek);
    const quarterCategories = Core.quarterCategoryGrid(stats.relevant, ui.selectedWeek);
    for (let hour = 0; hour < 24; hour += 1) {
      const hourLabel = document.createElement("span");
      hourLabel.className = "heatmap-label";
      hourLabel.textContent = hour % 3 === 0 ? String(hour) : "";
      root.appendChild(hourLabel);
      for (let day = 0; day < 7; day += 1) {
        const dayStart = Core.addDays(weekStart, day);
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "heatmap-cell";
        cell.dataset.action = "new-at";
        cell.dataset.date = Core.toLocalDateKey(dayStart);
        cell.dataset.hour = String(hour);
        cell.classList.toggle("today-column", isSameDate(dayStart, new Date()));
        cell.setAttribute("aria-label", `周${WEEKDAYS[day]} ${hour}点，点按补录`);
        for (let quarter = 0; quarter < 4; quarter += 1) {
          const id = quarterCategories[(day * 24 + hour) * 4 + quarter];
          const part = document.createElement("span");
          part.className = "heat-quarter";
          if (id) {
            const category = categoryById(id);
            part.style.background = category.color;
            part.title = category.name;
          }
          cell.appendChild(part);
        }
        root.appendChild(cell);
      }
    }
    const used = categoryTotalsSorted(stats);
    legend.innerHTML = used.length
      ? used.map(([id]) => {
        const category = categoryById(id);
        return `<span class="legend-item" style="--legend-color:${safeColor(category.color)}"><i class="legend-dot"></i>${escapeHtml(category.name)}</span>`;
      }).join("")
      : '<span class="legend-item">每格分成四段，可准确显示 15 分钟记录</span>';
  }

  function renderWeek() {
    updateWeekChrome();
    const stats = weekStats(ui.selectedWeek);
    setText("heatmapCoverage", `已记 ${formatHours(stats.trackedMinutes)}`);
    renderHeatmap(stats);
    renderCategoryBars("weekCategoryBars", stats);
  }

  function renderReport() {
    updateWeekChrome();
    const stats = weekStats(ui.selectedWeek);
    setText("reportTracked", formatHourNumber(stats.trackedMinutes));
    setText("reportWeekLabel", ui.selectedWeek === Core.weekKey(new Date()) ? "本周 · 基于当前记录" : `${formatWeekRange(ui.selectedWeek)} · 基于当前记录`);
    setText("reportCoverage", stats.untrackedMinutes
      ? `还有 ${formatHours(stats.untrackedMinutes)}待补`
      : "168 小时都已有去处");
    setText("reportEncouragement", stats.untrackedMinutes
      ? "留白也是真实生活的一部分。"
      : "完整看见这一周，也记得温柔看待自己。");
    $("reportDonut").style.setProperty("--donut-progress", `${Math.min(360, stats.trackedMinutes / Core.WEEK_MINUTES * 360)}deg`);
    let donutAngle = 0;
    const donutStops = categoryTotalsSorted(stats).map(([id, minutes]) => {
      const from = donutAngle;
      donutAngle = Math.min(360, donutAngle + minutes / Core.WEEK_MINUTES * 360);
      return `${safeColor(categoryById(id).color)} ${from}deg ${donutAngle}deg`;
    });
    $("reportDonut").style.setProperty("--donut-gradient", donutStops.length
      ? `conic-gradient(${donutStops.join(", ")}, var(--surface-soft) ${donutAngle}deg)`
      : "");

    const insights = [];
    if (!stats.trackedMinutes) {
      insights.push({ symbol: "1", title: "从一段开始", text: "先记下刚刚过去的 15 分钟或 1 小时，就已经足够。" });
    } else {
      const coverage = Math.round(stats.trackedMinutes / Core.WEEK_MINUTES * 100);
      insights.push({ symbol: "◷", title: `已看见这一周的 ${coverage}%`, text: stats.untrackedMinutes ? "以下观察都只基于当前记录，留白无需被评价。" : "这一周已经完整记录，可以安心回看时间去向。" });
    }
    insights.push(...(ReportExt ? ReportExt.render(stats, {
      $, setText, formatHours, formatPercentage,
      previous: weekStats(Core.addDays(Core.fromLocalDateKey(ui.selectedWeek), -7)),
    }) : renderGeneralReport(stats)));
    $("insightList").innerHTML = insights.map((item) => `<article class="insight-item"><span class="insight-symbol">${escapeHtml(item.symbol)}</span><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.text)}</p></div></article>`).join("");
    renderCategoryBars("reportCategoryBars", stats);
  }

  function weekStats(week) {
    const stats = Core.weekStats(state.entries, week, state.categories);
    return ReportExt ? ReportExt.extendStats(stats) : stats;
  }

  // Neutral report: three generic dimensions, never a score.
  function renderGeneralReport(stats) {
    setText("metricWorkStudy", formatHours(stats.workStudyMinutes));
    setText("metricLife", formatHours(stats.lifeMinutes));
    setText("metricRest", formatHours(stats.restLeisureMinutes));
    setText("metricUntracked", formatHours(stats.untrackedMinutes));
    if (!stats.trackedMinutes) return [];
    const insights = [];
    const totals = categoryTotalsSorted(stats);
    if (totals.length) {
      const [topId, topMinutes] = totals[0];
      insights.push({
        symbol: "↗",
        title: `目前最多的是${categoryById(topId).name}`,
        text: `${formatHours(topMinutes)}，占已记录时间 ${formatPercentage(topMinutes / stats.trackedMinutes)}%。`,
      });
    }
    const overview = [
      `工作/学习 ${formatHours(stats.workStudyMinutes)}`,
      `生活事务 ${formatHours(stats.lifeMinutes)}`,
      `休息娱乐 ${formatHours(stats.restLeisureMinutes)}`,
    ];
    insights.push({ symbol: "◇", title: "三个通用维度", text: `${overview.join(" · ")}。它们只是时间分布，不是好坏评分。` });
    return insights;
  }

  function weeksWithData() {
    const keys = new Set([Core.weekKey(new Date()), ui.selectedWeek]);
    state.entries.forEach((entry) => {
      keys.add(Core.weekKey(entry.start));
      keys.add(Core.weekKey(new Date(new Date(entry.end).getTime() - 1)));
    });
    return Array.from(keys).filter(Boolean).sort().reverse();
  }

  function historyStats(stats) {
    const pairs = ReportExt
      ? ReportExt.historyStats(stats)
      : [[stats.workStudyMinutes, "工作/学习"], [stats.restLeisureMinutes, "休息娱乐"]];
    return pairs.map(([minutes, label]) => `<span><b>${formatHours(minutes)}</b>${label}</span>`).join("");
  }

  function renderHistory() {
    updateWeekChrome();
    const root = $("historyList");
    if (!root) return;
    const currentKey = Core.weekKey(new Date());
    root.innerHTML = weeksWithData().map((key) => {
      const stats = weekStats(key);
      const totals = categoryTotalsSorted(stats);
      const segments = totals.map(([id, minutes]) => {
        const category = categoryById(id);
        return `<i style="--segment-color:${safeColor(category.color)};width:${Math.max(0, minutes / Core.WEEK_MINUTES * 100)}%" title="${escapeHtml(category.name)}"></i>`;
      }).join("");
      const topCategory = totals[0] ? categoryById(totals[0][0]).name : "暂无分类";
      const recordCount = stats.relevant.length;
      return `<button class="history-card" type="button" data-action="open-history-week" data-week="${key}"><span class="history-card-head"><span><strong>${key === currentKey ? "本周" : formatWeekRange(key)}</strong><small>${recordCount ? `${recordCount} 条记录 · 主要是 ${escapeHtml(topCategory)}` : "还没有记录，随时可以补上"}</small></span><span>已记 ${formatHours(stats.trackedMinutes)}</span></span><span class="history-mini-bar">${segments}</span><span class="history-stats">${historyStats(stats)}<span><b>${formatHours(stats.untrackedMinutes)}</b>待补</span></span></button>`;
    }).join("");
  }

  function renderSettings() {
    applyTheme();
    const enabled = $("reminderEnabled");
    const time = $("reminderTime");
    if (enabled) enabled.checked = state.settings.reminderEnabled;
    if (time) {
      time.value = state.settings.reminderTime;
      time.disabled = false;
    }
    const root = $("customCategoryList");
    const custom = state.categories.filter((category) => category.custom);
    if (root) {
      root.innerHTML = custom.length
        ? custom.map((category) => `<span class="custom-category-pill" style="--pill-color:${safeColor(category.color)}"><i></i>${escapeHtml(category.name)}<button type="button" data-action="delete-category" data-id="${escapeHtml(category.id)}" aria-label="删除${escapeHtml(category.name)}">×</button></span>`).join("")
        : '<span class="custom-category-pill">暂无自定义分类</span>';
    }
    const recoveryButton = $("exportRecoveryButton");
    const recoveryNotice = $("recoveryNotice");
    if (recoveryButton) recoveryButton.hidden = !preservedRawState;
    if (recoveryNotice) recoveryNotice.hidden = !preservedRawState;
    renderAiSettings();
  }

  function readAiBridge() {
    const bridge = nativeBridge();
    return bridge && typeof bridge.getAiProfiles === "function" ? bridge : null;
  }

  function readAiProfiles() {
    const bridge = readAiBridge();
    if (!bridge) return { ok: false, message: "文字识别需在 Android 安装版中使用。", profiles: [] };
    try {
      const result = JSON.parse(bridge.getAiProfiles());
      return result && result.ok && Array.isArray(result.profiles)
        ? result : { ok: false, message: result.message || "本机 API 配置无法读取", profiles: [] };
    } catch (error) {
      return { ok: false, message: "本机 API 配置无法读取", profiles: [] };
    }
  }

  function resetAiProfileForm() {
    ui.aiEditingProfileId = "";
    ui.aiCustomEndpoint = "";
    ui.aiCustomModel = "";
    ui.aiDeepseekModel = DEEPSEEK_MODEL;
    $("aiFormTitle").textContent = "添加 API 配置";
    $("aiProfileName").value = "DeepSeek";
    $("aiEndpoint").value = DEEPSEEK_ENDPOINT;
    $("aiProvider").value = "deepseek";
    $("aiKey").value = "";
    renderAiSettingsModels(DEEPSEEK_MODEL);
    updateAiProviderView();
    $("aiTestProfileButton").disabled = true;
  }

  function currentAiFormModel() {
    return $("aiModelSelect").value === "__custom"
      ? $("aiModel").value.trim() : $("aiModelSelect").value;
  }

  function aiModelName(id, name) {
    if (id === DEEPSEEK_MODEL || id === "deepseek-v4-flash") return "DeepSeek Flash";
    if (id === "deepseek-v4-pro") return "DeepSeek V4 Pro";
    return typeof name === "string" && name.trim() ? name.trim() : id;
  }

  function aiModelOptionLabel(id, name) {
    const displayName = aiModelName(id, name);
    return displayName === id || id === DEEPSEEK_MODEL || id === "deepseek-v4-pro"
      ? displayName : `${displayName} · ${id}`;
  }

  function renderAiSettingsModels(selectedModel) {
    const select = $("aiModelSelect");
    const deepseek = $("aiProvider").value === "deepseek";
    const endpoint = deepseek ? DEEPSEEK_ENDPOINT : $("aiEndpoint").value.trim();
    const editing = ui.aiProfiles.find((profile) => profile.id === ui.aiEditingProfileId && profile.endpoint === endpoint);
    const models = new Map();
    const add = (id, name) => {
      if (typeof id === "string" && id && id.length <= 100 && !models.has(id)) {
        models.set(id, typeof name === "string" && name ? name : id);
      }
    };
    if (deepseek) {
      add(DEEPSEEK_MODEL, "DeepSeek Flash");
      add("deepseek-v4-pro", "DeepSeek V4 Pro");
    }
    if (editing) {
      add(editing.model, editing.model);
      (Array.isArray(editing.models) ? editing.models : []).forEach((item) => add(item.id, item.name));
    }
    select.innerHTML = Array.from(models, ([id, name]) =>
      `<option value="${escapeHtml(id)}">${escapeHtml(aiModelOptionLabel(id, name))}</option>`).join("")
      + '<option value="__custom">手动填写其他模型…</option>';
    select.value = models.has(selectedModel) ? selectedModel : "__custom";
    $("aiModel").value = select.value === "__custom" ? selectedModel : "";
    $("aiManualModelWrap").hidden = select.value !== "__custom";
  }

  function renderAiProfileList() {
    const root = $("aiProfileList");
    root.innerHTML = ui.aiProfiles.length ? ui.aiProfiles.map((profile) => {
      let host = profile.endpoint;
      try { host = new URL(profile.endpoint).host; } catch (error) { /* Keep the saved address. */ }
      const active = profile.id === ui.aiActiveProfileId;
      return `<article class="ai-profile-card${active ? " active" : ""}">
        <div class="ai-profile-head"><strong>${escapeHtml(profile.name)}</strong>${active ? "<small>默认</small>" : ""}</div>
        <small class="ai-profile-meta">${escapeHtml(aiModelName(profile.model))} · ${escapeHtml(host)}</small>
        <button class="button secondary compact" type="button" data-action="edit-ai-profile" data-id="${escapeHtml(profile.id)}" aria-label="管理 ${escapeHtml(profile.name)}">管理</button>
        </article>`;
    }).join("") : '<p class="ai-settings-status">添加一个 API 配置，即可用文字补记。DeepSeek 只需填写自己的 Key。</p>';
  }

  function updateAiProfileEditor() {
    $("aiProfileEditor").hidden = !ui.aiEditorOpen;
    const editing = ui.aiProfiles.find((profile) => profile.id === ui.aiEditingProfileId);
    $("aiProfileEditActions").hidden = !editing;
    $("aiActivateProfileButton").dataset.id = editing ? editing.id : "";
    $("aiDeleteProfileButton").dataset.id = editing ? editing.id : "";
    $("aiActivateProfileButton").hidden = !editing || editing.id === ui.aiActiveProfileId;
    $("aiTestProfileButton").disabled = !editing || Boolean(ui.aiTestingId);
  }

  function closeAiProfileEditor(restoreFocus) {
    ui.aiEditorOpen = false;
    ui.aiEditingProfileId = "";
    $("aiKey").value = "";
    updateAiProfileEditor();
    if (restoreFocus !== false) $("aiNewProfileButton").focus({ preventScroll: true });
  }

  function renderAiSettings() {
    const result = readAiProfiles();
    if (result.ok) {
      ui.aiProfiles = result.profiles;
      ui.aiActiveProfileId = String(result.activeId || "");
    }
    renderAiProfileList();
    if (result.ok && ui.aiEditingProfileId && !ui.aiProfiles.some((profile) => profile.id === ui.aiEditingProfileId)) {
      closeAiProfileEditor(false);
    }
    updateAiProfileEditor();
    $("aiSettingsStatus").textContent = result.ok
      ? (ui.aiProfiles.length ? "密钥已加密保存在本机；点“管理”可编辑或测试。" : "保存配置后即可测试连接与模型。")
      : result.message;
  }

  function updateAiProviderView() {
    const custom = $("aiProvider").value === "custom";
    $("aiCustomFields").hidden = !custom;
    $("aiProviderHelp").textContent = custom
      ? "填写完整的 HTTPS Chat Completions 地址，选择或手动填写模型，再输入 API Key。"
      : "DeepSeek 接口已填好；可选默认模型，输入 API Key 后保存。";
    const editing = ui.aiProfiles.find((profile) => profile.id === ui.aiEditingProfileId);
    const endpoint = custom ? $("aiEndpoint").value.trim() : DEEPSEEK_ENDPOINT;
    $("aiKey").placeholder = editing && editing.endpoint === endpoint
      ? "留空保留已保存的密钥"
      : custom ? "粘贴该服务商的 API Key" : "粘贴 DeepSeek API Key";
  }

  function onAiProviderChange() {
    if ($("aiProvider").value === "deepseek") {
      if (!$("aiCustomFields").hidden) {
        ui.aiCustomEndpoint = $("aiEndpoint").value.trim();
        ui.aiCustomModel = currentAiFormModel();
      }
      $("aiEndpoint").value = DEEPSEEK_ENDPOINT;
      renderAiSettingsModels(ui.aiDeepseekModel);
    } else {
      ui.aiDeepseekModel = currentAiFormModel() || DEEPSEEK_MODEL;
      $("aiEndpoint").value = ui.aiCustomEndpoint;
      renderAiSettingsModels(ui.aiCustomModel);
    }
    updateAiProviderView();
  }

  function onAiSettingsModelChange() {
    const manual = $("aiModelSelect").value === "__custom";
    $("aiManualModelWrap").hidden = !manual;
    if (manual) $("aiModel").focus();
  }

  function saveAiProfile() {
    const bridge = readAiBridge();
    if (!bridge || typeof bridge.saveAiProfile !== "function") {
      showToast("请在 Android 安装版中配置文字识别");
      return;
    }
    try {
      const deepseek = $("aiProvider").value === "deepseek";
      const result = JSON.parse(bridge.saveAiProfile(
        ui.aiEditingProfileId,
        $("aiProfileName").value.trim(),
        deepseek ? DEEPSEEK_ENDPOINT : $("aiEndpoint").value.trim(),
        currentAiFormModel(),
        $("aiKey").value.trim()
      ));
      showToast(result.message || (result.ok ? "配置已保存" : "配置保存失败"));
      if (result.ok) {
        closeAiProfileEditor(false);
        renderAiSettings();
        $("aiNewProfileButton").focus({ preventScroll: true });
      }
    } catch (error) {
      showToast("配置保存失败，请检查输入内容");
    }
  }

  function newAiProfile() {
    resetAiProfileForm();
    ui.aiEditorOpen = true;
    updateAiProfileEditor();
    $("aiSettingsStatus").textContent = "新增配置不会影响已保存的 API Key。";
    $("aiProfileEditor").scrollIntoView({ block: "start" });
  }

  function editAiProfile(id) {
    const editing = ui.aiProfiles.find((profile) => profile.id === id);
    if (!editing) return;
    ui.aiEditingProfileId = id;
    ui.aiEditorOpen = true;
    $("aiFormTitle").textContent = `编辑 ${editing.name}`;
    $("aiProfileName").value = editing.name;
    $("aiEndpoint").value = editing.endpoint;
    $("aiProvider").value = editing.endpoint === DEEPSEEK_ENDPOINT ? "deepseek" : "custom";
    $("aiKey").value = "";
    if (editing.endpoint === DEEPSEEK_ENDPOINT) {
      ui.aiDeepseekModel = editing.model;
    } else {
      ui.aiCustomEndpoint = editing.endpoint;
      ui.aiCustomModel = editing.model;
    }
    renderAiSettingsModels(editing.model);
    updateAiProviderView();
    updateAiProfileEditor();
    $("aiProfileEditor").scrollIntoView({ block: "start" });
  }

  function deleteAiProfile(id) {
    const bridge = readAiBridge();
    const profile = ui.aiProfiles.find((item) => item.id === id);
    if (!bridge || !profile || typeof bridge.deleteAiProfile !== "function") return;
    if (!window.confirm(`确定删除“${profile.name}”和它的本机 API Key 吗？时间记录不会受影响。`)) return;
    try {
      const result = JSON.parse(bridge.deleteAiProfile(id));
      showToast(result.message || "配置已删除");
      if (result.ok && ui.aiEditingProfileId === id) closeAiProfileEditor(false);
      renderAiSettings();
    } catch (error) {
      showToast("暂时无法删除配置");
    }
  }

  function activateAiProfile(id) {
    const bridge = readAiBridge();
    if (!bridge || typeof bridge.activateAiProfile !== "function") return;
    try {
      const result = JSON.parse(bridge.activateAiProfile(id));
      showToast(result.message || "无法切换配置");
      if (result.ok) renderAiSettings();
    } catch (error) {
      showToast("暂时无法切换配置");
    }
  }

  function testAiProfile(id) {
    const bridge = readAiBridge();
    const profileId = id || ui.aiEditingProfileId;
    if (!profileId) {
      showToast("请先保存配置，再测试 API");
      return;
    }
    const editing = ui.aiProfiles.find((profile) => profile.id === profileId);
    const formEndpoint = $("aiProvider").value === "deepseek" ? DEEPSEEK_ENDPOINT : $("aiEndpoint").value.trim();
    if (!id && editing && (currentAiFormModel() !== editing.model || formEndpoint !== editing.endpoint || $("aiKey").value.trim())) {
      showToast("请先保存配置改动，再测试 API");
      return;
    }
    if (!bridge || typeof bridge.testAiProfile !== "function" || ui.aiTestingId) return;
    ui.aiTestingId = profileId;
    $("aiSettingsStatus").textContent = "正在测试连接、API Key 和默认模型…";
    $("aiTestProfileButton").disabled = true;
    try {
      bridge.testAiProfile(profileId);
    } catch (error) {
      ui.aiTestingId = "";
      $("aiTestProfileButton").disabled = false;
      showToast("无法启动 API 测试");
    }
  }

  function receiveAiProfileTest(raw) {
    try {
      const payload = JSON.parse(String(raw || "{}"));
      if (payload.requestId !== ui.aiTestingId) return;
      ui.aiTestingId = "";
      renderAiSettings();
      if (ui.aiEditorOpen && ui.aiEditingProfileId === payload.requestId) {
        renderAiSettingsModels(currentAiFormModel());
      }
      const result = payload.result || {};
      $("aiSettingsStatus").textContent = result.message || "API 测试未完成";
      showToast(result.ok ? "API 测试通过" : (result.message || "API 测试失败"));
    } catch (error) {
      ui.aiTestingId = "";
      $("aiTestProfileButton").disabled = false;
      showToast("测试结果无法读取");
    }
  }

  function clearAiResult() {
    ui.aiDrafts = [];
    ui.aiUnresolved = [];
    $("aiResult").hidden = true;
    $("aiDraftList").replaceChildren();
  }

  function selectedAiProfile() {
    return ui.aiProfiles.find((profile) => profile.id === $("aiImportProfile").value) || null;
  }

  function updateAiImportNotice() {
    const profile = selectedAiProfile();
    let destination = "你选择的 API 服务商";
    try { if (profile) destination = new URL(profile.endpoint).host; }
    catch (error) { /* Keep the generic disclosure. */ }
    $("aiSendNotice").textContent = `确认文字后点“发送并识别”。仅这段文字、所选日期和分类名称会发送到 ${destination}；结果会先作为草稿展示。`;
    $("aiSetupHint").hidden = Boolean(profile);
    $("aiAnalyzeButton").disabled = ui.aiPending || !profile;
    const deepseek = Boolean(profile && profile.endpoint === DEEPSEEK_ENDPOINT);
    $("aiThinkingOption").hidden = !deepseek;
    if (!deepseek) $("aiDeepThinking").checked = false;
    updateAiRecognitionSummary();
  }

  function updateAiRecognitionSummary() {
    const profile = selectedAiProfile();
    if (!profile) {
      $("aiRecognitionSummary").textContent = "请先添加 API 配置";
      return;
    }
    const model = $("aiImportModel").value === "__custom"
      ? $("aiImportCustomModel").value.trim() : $("aiImportModel").value;
    const discovered = (Array.isArray(profile.models) ? profile.models : []).find((item) => item.id === model);
    const modelName = model ? aiModelName(model, discovered && discovered.name) : "待填写模型";
    const deepseek = profile.endpoint === DEEPSEEK_ENDPOINT;
    $("aiRecognitionSummary").textContent = deepseek
      ? `${modelName} · ${$("aiDeepThinking").checked ? "深度" : "快速"}`
      : `${profile.name} · ${modelName}`;
  }

  function renderAiImportModels() {
    const profile = selectedAiProfile();
    const select = $("aiImportModel");
    if (!profile) {
      select.innerHTML = '<option value="">先选择 API 配置</option>';
      select.value = "";
      $("aiImportCustomModelWrap").hidden = true;
      updateAiImportNotice();
      return;
    }
    const models = new Map();
    const add = (id, name) => {
      if (typeof id === "string" && id && id.length <= 100 && !models.has(id)) {
        models.set(id, typeof name === "string" && name ? name : id);
      }
    };
    if (profile.endpoint === DEEPSEEK_ENDPOINT) {
      add(DEEPSEEK_MODEL, "DeepSeek Flash");
      add("deepseek-v4-pro", "DeepSeek V4 Pro");
    }
    add(profile.model, profile.model);
    (Array.isArray(profile.models) ? profile.models : []).forEach((item) => add(item.id, item.name));
    select.innerHTML = Array.from(models, ([id, name]) =>
      `<option value="${escapeHtml(id)}">${escapeHtml(aiModelOptionLabel(id, name))}</option>`).join("")
      + '<option value="__custom">手动填写其他模型…</option>';
    select.value = profile.model;
    $("aiImportCustomModelWrap").hidden = true;
    updateAiImportNotice();
  }

  function renderAiImportProfiles() {
    const result = readAiProfiles();
    ui.aiProfiles = result.ok ? result.profiles : [];
    ui.aiActiveProfileId = result.ok ? String(result.activeId || "") : "";
    $("aiImportProfile").innerHTML = ui.aiProfiles.length
      ? ui.aiProfiles.map((profile) => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`).join("")
      : '<option value="">先在设置中保存 API 配置</option>';
    $("aiImportProfile").value = ui.aiProfiles.some((profile) => profile.id === ui.aiActiveProfileId)
      ? ui.aiActiveProfileId : (ui.aiProfiles[0] ? ui.aiProfiles[0].id : "");
    renderAiImportModels();
  }

  function onAiImportModelChange() {
    const manual = $("aiImportModel").value === "__custom";
    $("aiImportCustomModelWrap").hidden = !manual;
    if (manual) $("aiImportCustomModel").focus();
    updateAiRecognitionSummary();
    clearAiResult();
  }

  function openAiImport() {
    if (!TextImport) {
      showToast("文字识别组件暂时不可用");
      return;
    }
    $("aiDate").value = ui.selectedDate;
    if (!$("aiText").value.trim()) restoreAiDraftText();
    $("aiDeepThinking").checked = false;
    $("aiRecognitionSettings").open = false;
    clearAiResult();
    renderAiImportProfiles();
    setSheetOpen("aiSheet", "aiBackdrop", true);
    window.requestAnimationFrame(() => { $("aiSheet").scrollTop = 0; });
  }

  function storeAiDraftText() {
    try {
      const text = $("aiText").value;
      if (text.trim()) {
        localStorage.setItem(AI_DRAFT_KEY, JSON.stringify({ date: $("aiDate").value, text, savedAt: Date.now() }));
      } else {
        localStorage.removeItem(AI_DRAFT_KEY);
      }
    } catch (error) { /* Drafts are a convenience; typing must never fail. */ }
  }

  function restoreAiDraftText() {
    try {
      const draft = JSON.parse(localStorage.getItem(AI_DRAFT_KEY) || "null");
      if (!draft || typeof draft.text !== "string" || !draft.text.trim()
          || !(Date.now() - Number(draft.savedAt) < AI_DRAFT_MAX_AGE_DAYS * 86400000)) {
        localStorage.removeItem(AI_DRAFT_KEY);
        return;
      }
      $("aiText").value = draft.text.slice(0, 4000);
      if (Core.fromLocalDateKey(draft.date)) $("aiDate").value = draft.date;
      showToast("已恢复上次没发送的文字");
    } catch (error) { /* Ignore unreadable drafts. */ }
  }

  function clearAiDraftText() {
    $("aiText").value = "";
    try { localStorage.removeItem(AI_DRAFT_KEY); } catch (error) { /* Optional. */ }
  }

  function closeAiImport() {
    setSheetOpen("aiSheet", "aiBackdrop", false);
    setAiPending(false);
    ui.aiRequestId = "";
  }

  function setAiPending(pending) {
    if (ui.aiElapsedTimer) window.clearInterval(ui.aiElapsedTimer);
    ui.aiElapsedTimer = 0;
    ui.aiPending = pending;
    $("aiAnalyzeButton").disabled = pending || !selectedAiProfile();
    if (pending) {
      ui.aiStartedAt = performance.now();
      const updateElapsed = () => {
        $("aiAnalyzeButton").textContent = `正在识别 · ${Math.floor((performance.now() - ui.aiStartedAt) / 1000)} 秒`;
      };
      updateElapsed();
      ui.aiElapsedTimer = window.setInterval(updateElapsed, 1000);
    } else {
      $("aiAnalyzeButton").textContent = "发送并识别";
    }
    $("aiDate").disabled = pending;
    $("aiText").disabled = pending;
    $("aiImportProfile").disabled = pending;
    $("aiImportModel").disabled = pending;
    $("aiImportCustomModel").disabled = pending;
    $("aiDeepThinking").disabled = pending;
  }

  function analyzeDayText() {
    const bridge = readAiBridge();
    if (!bridge || typeof bridge.analyzeDayText !== "function") {
      showToast("请在 Android 安装版中使用文字识别");
      return;
    }
    if (ui.aiPending) return;
    const profile = selectedAiProfile();
    const model = $("aiImportModel").value === "__custom"
      ? $("aiImportCustomModel").value.trim() : $("aiImportModel").value;
    if (!profile || !model || model.length > 100) {
      showToast("请选择 API 配置和有效模型");
      return;
    }
    const date = $("aiDate").value;
    const text = $("aiText").value.trim();
    if (!Core.fromLocalDateKey(date)) {
      showToast("请先选择有效日期");
      return;
    }
    if (!text || text.length > 4000) {
      showToast("请输入 1 到 4000 字的当天活动描述");
      return;
    }
    clearAiResult();
    ui.aiLastDurationSeconds = 0;
    setAiPending(true);
    ui.aiRequestId = Core.makeId("ai");
    try {
      bridge.analyzeDayText(JSON.stringify({
        requestId: ui.aiRequestId,
        profileId: profile.id,
        model,
        deepThinking: profile.endpoint === DEEPSEEK_ENDPOINT && $("aiDeepThinking").checked,
        date,
        text,
        categories: state.categories.map((category) => ({ id: category.id, name: category.name })),
      }));
    } catch (error) {
      setAiPending(false);
      ui.aiRequestId = "";
      showToast("无法连接文字识别服务，请检查设置");
    }
  }

  function renderAiDrafts() {
    const categoryOptions = '<option value="">选择分类</option>' + state.categories.map((category) =>
      `<option value="${escapeHtml(category.id)}">${escapeHtml(category.name)}</option>`).join("");
    $("aiDraftList").innerHTML = ui.aiDrafts.map((draft, index) => `
      <article class="ai-draft" data-ai-index="${index}">
        <label class="ai-draft-head"><input type="checkbox" data-ai-field="selected" ${draft.selected ? "checked" : ""} />第 ${index + 1} 段${draft.inferred ? ' <small>结束时间由下一段推断，请核对</small>' : ""}</label>
        <div class="ai-draft-fields">
          <label>开始 <input type="text" inputmode="numeric" maxlength="5" placeholder="09:00" data-ai-field="start" value="${escapeHtml(draft.start)}" /></label>
          <label>结束 <input type="text" inputmode="numeric" maxlength="5" placeholder="12:00" data-ai-field="end" value="${escapeHtml(draft.end)}" /></label>
          <label class="wide">分类 <select data-ai-field="categoryId">${categoryOptions}</select></label>
          <label class="wide">内容 <input type="text" maxlength="160" data-ai-field="content" value="${escapeHtml(draft.content)}" /></label>
        </div>
        <p class="ai-draft-error" data-ai-error></p>
      </article>`).join("");
    all("[data-ai-index]", $("aiDraftList")).forEach((row) => {
      const index = Number(row.dataset.aiIndex);
      row.querySelector('[data-ai-field="categoryId"]').value = ui.aiDrafts[index].categoryId;
    });
    $("aiUnresolved").hidden = ui.aiUnresolved.length === 0;
    $("aiUnresolvedList").innerHTML = ui.aiUnresolved.map((item, index) => `
      <div class="ai-unresolved-item"><div>${escapeHtml(item.text)}<small>${escapeHtml(item.reason)}</small></div>
        <button type="button" data-action="add-unresolved" data-index="${index}">补时间</button></div>`).join("");
    $("aiResult").hidden = false;
    refreshAiValidation();
  }

  function refreshAiValidation() {
    const checked = TextImport.validateDrafts(
      $("aiDate").value, ui.aiDrafts, state.categories, state.entries, new Date()
    );
    const errors = new Map(checked.errors.map((item) => [item.index, item.message]));
    all("[data-ai-index]", $("aiDraftList")).forEach((row) => {
      row.querySelector("[data-ai-error]").textContent = errors.get(Number(row.dataset.aiIndex)) || "";
    });
    $("aiResultSummary").textContent = `${ui.aiDrafts.length} 段草稿 · ${ui.aiUnresolved.length} 段待补时间`
      + (ui.aiLastDurationSeconds ? ` · 用时 ${ui.aiLastDurationSeconds} 秒` : "");
    $("aiValidationSummary").textContent = checked.errors.length
      ? `${checked.errors.length} 段需要调整；已选记录不会覆盖已有时间。`
      : checked.selectedCount ? `已选 ${checked.selectedCount} 段，确认后一次保存。`
        : "勾选至少一段完整记录后保存。";
    $("aiSaveButton").disabled = checked.selectedCount === 0 || checked.errors.length > 0;
    return checked;
  }

  function onAiDraftChange(event) {
    const row = event.target.closest("[data-ai-index]");
    if (!row) return;
    const draft = ui.aiDrafts[Number(row.dataset.aiIndex)];
    const field = event.target.dataset.aiField;
    if (!draft || !["selected", "start", "end", "categoryId", "content"].includes(field)) return;
    draft[field] = field === "selected" ? event.target.checked : event.target.value;
    refreshAiValidation();
  }

  function receiveAiResult(raw) {
    if (!ui.aiPending) return;
    try {
      const payload = JSON.parse(String(raw || "{}"));
      if (payload.requestId !== ui.aiRequestId) return;
      ui.aiLastDurationSeconds = Math.round((performance.now() - ui.aiStartedAt) / 1000);
      setAiPending(false);
      ui.aiRequestId = "";
      const result = payload.result || {};
      if (!result.ok) {
        showToast(result.message || "识别失败，请稍后重试");
        return;
      }
      const parsed = TextImport.parseResponse(result.content);
      if (!parsed.ok) {
        showToast(parsed.message);
        return;
      }
      ui.aiDrafts = parsed.drafts;
      ui.aiUnresolved = parsed.unresolved;
      renderAiDrafts();
      if (!ui.aiDrafts.length && !ui.aiUnresolved.length) showToast("没有识别到明确活动，可以补充时间后重试");
    } catch (error) {
      setAiPending(false);
      ui.aiRequestId = "";
      showToast("识别结果无法解析，请换一个模型重试");
    }
  }

  function addUnresolved(index) {
    const item = ui.aiUnresolved[index];
    if (!item || ui.aiDrafts.length >= TextImport.MAX_ITEMS) return;
    ui.aiDrafts.push({ selected: true, start: "", end: "", categoryId: "", content: item.text });
    ui.aiUnresolved.splice(index, 1);
    renderAiDrafts();
  }

  function saveAiDrafts() {
    const checked = refreshAiValidation();
    if (!checked.selectedCount || checked.errors.length) {
      showToast("请先调整时间、分类和冲突记录");
      return;
    }
    const before = clone(state.entries);
    const timestamp = new Date().toISOString();
    const additions = checked.candidates.map((item) => ({
      id: Core.makeId("entry"), ...item, location: "", energy: 0, mood: 0, note: "",
      createdAt: timestamp, updatedAt: timestamp,
    }));
    state.entries = before.concat(additions)
      .sort((a, b) => new Date(a.start) - new Date(b.start));
    if (!persist()) {
      state.entries = before;
      return;
    }
    ui.selectedDate = $("aiDate").value;
    ui.selectedWeek = Core.weekKey(Core.fromLocalDateKey(ui.selectedDate));
    ui.shouldScrollTimeline = true;
    clearAiDraftText();
    closeAiImport();
    renderAll();
    withEntryUndo(`一次保存了 ${additions.length} 段记录`, before);
  }

  function renderAll() {
    // Hidden views render lazily when opened. This keeps each save fast even
    // after years of history have accumulated.
    navigate(ui.view);
  }

  function setSheetOpen(sheetId, backdropId, open) {
    const sheet = $(sheetId);
    const backdrop = $(backdropId);
    if (!sheet || !backdrop) return;
    const appShell = $("appShell");
    if (open) {
      ui.sheetReturnFocus[sheetId] = document.activeElement;
      sheet.classList.remove("hidden");
      backdrop.classList.remove("hidden");
      backdrop.setAttribute("aria-hidden", "false");
      try { sheet.focus({ preventScroll: true }); } catch (error) { sheet.focus(); }
      appShell.inert = true;
      appShell.setAttribute("aria-hidden", "true");
      document.body.style.overflow = "hidden";
      return;
    }
    sheet.classList.add("hidden");
    backdrop.classList.add("hidden");
    backdrop.setAttribute("aria-hidden", "true");
    appShell.inert = false;
    appShell.removeAttribute("aria-hidden");
    document.body.style.overflow = "";
    const returnFocus = ui.sheetReturnFocus[sheetId];
    delete ui.sheetReturnFocus[sheetId];
    if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === "function") {
      window.requestAnimationFrame(() => {
        try { returnFocus.focus({ preventScroll: true }); } catch (error) { returnFocus.focus(); }
      });
    }
  }

  function renderRatings() {
    [["energyRating", "能量"], ["moodRating", "心情"]].forEach(([id, label]) => {
      const root = $(id);
      const value = Number(root.dataset.value || 0);
      root.replaceChildren();
      for (let rating = 1; rating <= 5; rating += 1) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = String(rating);
        button.dataset.action = "set-rating";
        button.dataset.ratingTarget = id;
        button.dataset.value = String(rating);
        button.classList.toggle("active", rating <= value);
        button.setAttribute("aria-label", `${label}${rating}分`);
        button.setAttribute("aria-pressed", String(rating === value));
        root.appendChild(button);
      }
    });
  }

  function categoriesByRecentUse() {
    const lastUsed = Object.create(null);
    state.entries.forEach((entry) => {
      const time = new Date(entry.end).getTime();
      if (!(lastUsed[entry.categoryId] >= time)) lastUsed[entry.categoryId] = time;
    });
    return state.categories
      .map((category, index) => ({ category, index }))
      .sort((a, b) => (lastUsed[b.category.id] || 0) - (lastUsed[a.category.id] || 0) || a.index - b.index)
      .map((item) => item.category);
  }

  function renderCategoryPicker() {
    const root = $("categoryPicker");
    if (!root) return;
    root.innerHTML = categoriesByRecentUse().map((category) => `<button class="category-choice${category.id === ui.selectedCategory ? " selected" : ""}" type="button" data-action="pick-category" data-id="${escapeHtml(category.id)}" style="--choice-color:${safeColor(category.color)}" aria-pressed="${category.id === ui.selectedCategory}"><i></i><span>${escapeHtml(category.name)}</span></button>`).join("");
    $("entryCategory").value = ui.selectedCategory;
  }

  function entryDefaults(dateKey, hour) {
    const now = new Date();
    const key = dateKey || ui.selectedDate || Core.toLocalDateKey(now);
    let start;
    let end;
    if (Number.isFinite(hour)) {
      start = Core.fromLocalDateKey(key, hour * 60);
      end = Core.addMinutes(start, 60);
    } else if (key === Core.toLocalDateKey(now)) {
      // A time log should never silently include minutes that have not happened
      // yet. At midnight this naturally produces 23:00–00:00 on the prior day.
      end = Core.roundToQuarter(now, "floor");
      start = Core.addMinutes(end, -60);
      // Prefer the open gap that runs up to now, e.g. "last entry ended at
      // 16:00" becomes 16:00–now; very long gaps keep the one-hour default.
      const dayStart = Core.fromLocalDateKey(key);
      const openGap = Core.subtractIntervals(dayStart, end, state.entries).pop();
      if (openGap && openGap.end.getTime() === end.getTime()
          && Core.durationMinutes(openGap.start, end) >= 15
          && Core.durationMinutes(openGap.start, end) <= 12 * 60) {
        start = openGap.start;
      }
    } else {
      start = Core.fromLocalDateKey(key, 9 * 60);
      end = Core.addMinutes(start, 60);
    }
    const latest = state.entries.slice().sort((a, b) => new Date(b.end) - new Date(a.end))[0];
    return { start, end, categoryId: latest ? latest.categoryId : "", content: "", location: "", energy: 0, mood: 0, note: "" };
  }

  function fillEntryForm(entry, isEdit) {
    const start = new Date(entry.start);
    const end = new Date(entry.end);
    ui.editingId = isEdit ? entry.id : "";
    ui.selectedCategory = state.categories.some((category) => category.id === entry.categoryId) ? entry.categoryId : "";
    $("entryId").value = ui.editingId;
    $("entryDate").value = Core.toLocalDateKey(start);
    $("entryStart").value = Core.minutesToTime(Core.minutesOfDay(start));
    $("entryEnd").value = Core.minutesToTime(Core.minutesOfDay(end));
    $("entryContent").value = entry.content || "";
    $("entryLocation").value = entry.location || "";
    $("entryNote").value = entry.note || "";
    $("energyRating").dataset.value = String(Number(entry.energy) || 0);
    $("moodRating").dataset.value = String(Number(entry.mood) || 0);
    // Without rating controls the hidden dataset still carries legacy values,
    // so editing an entry keeps its energy/mood in the JSON schema.
    $("moreFields").open = Boolean(entry.location || entry.note
      || (FEATURES.ratings && (entry.energy || entry.mood)));
    $("editActions").classList.toggle("hidden", !isEdit);
    setText("entrySheetTitle", isEdit ? "编辑这段时间" : "记一段时间");
    renderCategoryPicker();
    renderRatings();
    updateDurationHelper();
  }

  function openEntry(options) {
    const config = options || {};
    if (config.id) {
      const existing = state.entries.find((entry) => entry.id === config.id);
      if (!existing) {
        showToast("这条记录已不存在");
        return;
      }
      fillEntryForm(existing, true);
    } else {
      const defaults = config.defaults || entryDefaults(config.date, Number.isFinite(config.hour) ? config.hour : NaN);
      fillEntryForm({
        ...defaults,
        id: "",
        start: Core.asDate(defaults.start).toISOString(),
        end: Core.asDate(defaults.end).toISOString(),
      }, false);
    }
    setSheetOpen("entrySheet", "entryBackdrop", true);
    window.requestAnimationFrame(() => $("entrySheet").scrollTop = 0);
  }

  function closeEntry() {
    setSheetOpen("entrySheet", "entryBackdrop", false);
    ui.editingId = "";
  }

  function parsedFormRange(showError) {
    const key = $("entryDate").value;
    const startMinutes = Core.parseTime($("entryStart").value);
    const endMinutes = Core.parseTime($("entryEnd").value);
    if (!Core.fromLocalDateKey(key) || startMinutes == null || endMinutes == null) {
      if (showError) showToast("请选择有效的日期和时间");
      return null;
    }
    if (startMinutes % 15 || endMinutes % 15) {
      if (showError) showToast("开始和结束时间需对齐到 15 分钟");
      return null;
    }
    if (startMinutes === endMinutes) {
      if (showError) showToast("开始和结束不能相同，请至少记录 15 分钟");
      return null;
    }
    const start = Core.fromLocalDateKey(key, startMinutes);
    let end = Core.fromLocalDateKey(key, endMinutes);
    const crossesMidnight = endMinutes < startMinutes;
    if (crossesMidnight) end = Core.addDays(end, 1);
    const duration = Core.durationMinutes(start, end);
    if (!duration || duration >= Core.DAY_MINUTES) {
      if (showError) showToast("单条记录需在 15 分钟到 24 小时以内");
      return null;
    }
    return { start, end, duration, crossesMidnight };
  }

  function updateDurationHelper() {
    const range = parsedFormRange(false);
    if (!range) {
      setText("durationHelper", "请选择不同的开始和结束时间；精度为 15 分钟");
      return;
    }
    setText("durationHelper", `${Core.formatDuration(range.duration)}${range.crossesMidnight ? " · 跨到次日" : ""} · 15 分钟精度`);
  }

  function setEntryDuration(value) {
    const key = $("entryDate").value;
    const startMinutes = Core.parseTime($("entryStart").value);
    if (!Core.fromLocalDateKey(key) || startMinutes == null) return;
    if (value === "now") {
      const now = Core.roundToQuarter(new Date(), "floor");
      if (key !== Core.toLocalDateKey(now)) {
        showToast("“到现在”仅适用于今天");
        return;
      }
      const nowMinutes = Core.minutesOfDay(now);
      if (nowMinutes <= startMinutes) {
        showToast("开始时间还没到，请调整后再使用“到现在”");
        return;
      }
      $("entryEnd").value = Core.minutesToTime(nowMinutes);
    } else {
      const minutes = Number(value);
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes >= Core.DAY_MINUTES) return;
      $("entryEnd").value = Core.minutesToTime(startMinutes + minutes);
    }
    updateDurationHelper();
  }

  function saveEntry() {
    const range = parsedFormRange(true);
    if (!range) return;
    if (!ui.selectedCategory || !state.categories.some((category) => category.id === ui.selectedCategory)) {
      showToast("请选择一个分类");
      return;
    }
    const existing = ui.editingId ? state.entries.find((entry) => entry.id === ui.editingId) : null;
    const candidate = {
      id: existing ? existing.id : Core.makeId("entry"),
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      categoryId: ui.selectedCategory,
      content: $("entryContent").value.trim(),
      location: $("entryLocation").value.trim(),
      energy: Number($("energyRating").dataset.value) || 0,
      mood: Number($("moodRating").dataset.value) || 0,
      note: $("entryNote").value.trim(),
      createdAt: existing ? existing.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const before = clone(state.entries);
    const result = Core.upsertEntry(state.entries, candidate);
    if (result.noSpace) {
      showToast("这段时间无法保存，请检查起止时间");
      return;
    }
    state.entries = result.entries;
    if (!persist()) {
      state.entries = before;
      return;
    }
    closeEntry();
    renderAll();
    const suffix = result.trimmedMinutes ? `，并覆盖 ${Core.formatDuration(result.trimmedMinutes)}` : "";
    withEntryUndo(`${existing ? "修改" : "记录"}已保存${suffix}`, before);
  }

  function deleteEntry() {
    const entry = state.entries.find((item) => item.id === ui.editingId);
    if (!entry) return;
    if (!window.confirm("确定删除这条记录吗？删除后可在 8 秒内撤销。")) return;
    const before = clone(state.entries);
    state.entries = state.entries.filter((item) => item.id !== entry.id);
    if (!persist()) {
      state.entries = before;
      return;
    }
    closeEntry();
    renderAll();
    withEntryUndo("记录已删除", before);
  }

  function continueLastEntry() {
    const latest = state.entries.slice().sort((a, b) => new Date(b.end) - new Date(a.end))[0];
    if (!latest) {
      openEntry();
      return;
    }
    const start = new Date(latest.end);
    let end = Core.addMinutes(start, 60);
    const now = Core.roundToQuarter(new Date(), "floor");
    if (now > start && Core.durationMinutes(start, now) <= 6 * 60) end = now;
    openEntry({ defaults: { start, end, categoryId: latest.categoryId, content: "", location: latest.location || "", energy: 0, mood: 0, note: "" } });
  }

  function renderColorPicker() {
    const root = $("colorPicker");
    root.innerHTML = CATEGORY_COLORS.map((color) => `<button class="color-choice${color === ui.selectedColor ? " selected" : ""}" type="button" data-action="pick-color" data-color="${color}" style="--color:${color}" aria-label="选择颜色 ${color}" aria-pressed="${color === ui.selectedColor}"></button>`).join("");
  }

  function openCategorySheet() {
    $("newCategoryName").value = "";
    ui.selectedColor = CATEGORY_COLORS[state.categories.filter((item) => item.custom).length % CATEGORY_COLORS.length];
    renderColorPicker();
    setSheetOpen("categorySheet", "categoryBackdrop", true);
    window.setTimeout(() => {
      if (!$("categorySheet").classList.contains("hidden")) $("newCategoryName").focus();
    }, 120);
  }

  function closeCategorySheet() {
    setSheetOpen("categorySheet", "categoryBackdrop", false);
  }

  function saveCategory() {
    const name = $("newCategoryName").value.trim();
    if (!name || name.length > 12) {
      showToast("分类名称需为 1–12 个字");
      return;
    }
    if (state.categories.some((category) => category.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      showToast("已经有同名分类了");
      return;
    }
    const customCategoryLimit = MAX_CATEGORIES - DEFAULT_CATEGORIES.length;
    if (state.categories.filter((category) => category.custom).length >= customCategoryLimit) {
      showToast(`自定义分类已达到 ${customCategoryLimit} 个安全上限`);
      return;
    }
    state.categories.push({ id: Core.makeId("custom"), name, color: safeColor(ui.selectedColor), custom: true, sleep: false, lowQuality: false });
    if (!persist()) {
      state.categories.pop();
      return;
    }
    closeCategorySheet();
    renderAll();
    showToast(`已添加“${name}”`);
  }

  function deleteCategory(id) {
    const category = state.categories.find((item) => item.id === id && item.custom);
    if (!category) return;
    const used = state.entries.filter((entry) => entry.categoryId === id).length;
    if (used) {
      showToast(`“${category.name}”已有 ${used} 条记录，需先改分类后才能删除`);
      return;
    }
    if (!window.confirm(`确定删除自定义分类“${category.name}”吗？`)) return;
    const before = state.categories;
    state.categories = state.categories.filter((item) => item.id !== id);
    if (!persist()) {
      state.categories = before;
      renderSettings();
      return;
    }
    renderAll();
    showToast("分类已删除");
  }

  function makeBackup() {
    return {
      app: Edition.backup.app,
      version: DATA_VERSION,
      exportedAt: new Date().toISOString(),
      entries: clone(state.entries),
      categories: clone(state.categories),
      settings: clone(state.settings),
    };
  }

  function validateBackup(raw) {
    let value;
    try {
      value = typeof raw === "string" ? JSON.parse(raw.replace(/^\uFEFF/, "")) : raw;
    } catch (error) {
      return { ok: false, message: "文件不是有效的 JSON" };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, message: "备份根结构不正确" };
    if (!Edition.backup.accept.includes(value.app) || value.version !== DATA_VERSION) return { ok: false, message: `这不是当前版本导出的 ${Edition.appName} 备份` };
    if (!Array.isArray(value.entries) || !Array.isArray(value.categories) || !value.settings || typeof value.settings !== "object") {
      return { ok: false, message: "备份缺少记录、分类或设置" };
    }
    if (value.entries.length > 200000 || value.categories.length > MAX_CATEGORIES) return { ok: false, message: "备份内容超出安全限制" };
    const categoryIds = new Set();
    const defaultCategories = new Map(DEFAULT_CATEGORIES.map((category) => [category.id, category]));
    const defaultCategoryIds = new Set(defaultCategories.keys());
    for (const rawCategory of value.categories) {
      if (!rawCategory || typeof rawCategory !== "object" || Array.isArray(rawCategory)
          || typeof rawCategory.id !== "string" || typeof rawCategory.name !== "string"
          || typeof rawCategory.color !== "string" || typeof rawCategory.custom !== "boolean"
          || (Object.prototype.hasOwnProperty.call(rawCategory, "sleep") && typeof rawCategory.sleep !== "boolean")
          || (Object.prototype.hasOwnProperty.call(rawCategory, "lowQuality") && typeof rawCategory.lowQuality !== "boolean")) {
        return { ok: false, message: "备份中的分类类型不完整" };
      }
      if (rawCategory.id !== rawCategory.id.trim() || rawCategory.id.length > 80
          || rawCategory.name !== rawCategory.name.trim() || !rawCategory.name || rawCategory.name.length > 24
          || !/^#[0-9a-f]{6}$/i.test(rawCategory.color)) {
        return { ok: false, message: "备份中的分类字段格式不正确" };
      }
      const category = cleanCategory(rawCategory, rawCategory.custom);
      if (!category || category.id !== rawCategory.id || category.name !== rawCategory.name
          || category.color !== rawCategory.color || categoryIds.has(category.id)) {
        return { ok: false, message: "备份中有无效或重复分类" };
      }
      if (defaultCategoryIds.has(category.id) === category.custom) {
        return { ok: false, message: "备份中的默认分类或自定义分类标记不正确" };
      }
      const expectedDefault = defaultCategories.get(category.id);
      if (expectedDefault) {
        if (category.name !== expectedDefault.name || category.color !== expectedDefault.color
            || category.sleep !== Boolean(expectedDefault.sleep)
            || category.lowQuality !== Boolean(expectedDefault.lowQuality)) {
          return { ok: false, message: "备份中的默认分类被异常修改" };
        }
      } else if (category.sleep || category.lowQuality) {
        return { ok: false, message: "自定义分类不能伪装成系统统计分类" };
      }
      categoryIds.add(category.id);
    }
    if (DEFAULT_CATEGORIES.some((category) => !categoryIds.has(category.id))) return { ok: false, message: "备份缺少必要的默认分类" };
    const ids = new Set();
    const entries = [];
    for (const rawEntry of value.entries) {
      if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)
          || typeof rawEntry.id !== "string" || !rawEntry.id || rawEntry.id.length > 200
          || typeof rawEntry.start !== "string" || typeof rawEntry.end !== "string"
          || typeof rawEntry.categoryId !== "string" || !rawEntry.categoryId || rawEntry.categoryId.length > 80
          || typeof rawEntry.content !== "string" || rawEntry.content.length > 160
          || typeof rawEntry.location !== "string" || rawEntry.location.length > 80
          || typeof rawEntry.note !== "string" || rawEntry.note.length > 1200
          || !Number.isInteger(rawEntry.energy) || rawEntry.energy < 0 || rawEntry.energy > 5
          || !Number.isInteger(rawEntry.mood) || rawEntry.mood < 0 || rawEntry.mood > 5
          || typeof rawEntry.createdAt !== "string" || typeof rawEntry.updatedAt !== "string") {
        return { ok: false, message: "备份中的记录字段类型或长度不正确" };
      }
      const start = new Date(rawEntry.start);
      const end = new Date(rawEntry.end);
      const canonicalDates = [rawEntry.start, rawEntry.end, rawEntry.createdAt, rawEntry.updatedAt]
        .every(isCanonicalIsoString);
      if (!canonicalDates || !Core.isValidEntry(rawEntry) || ids.has(rawEntry.id) || !categoryIds.has(rawEntry.categoryId)) {
        return { ok: false, message: "备份中有无效、重复或分类缺失的记录" };
      }
      const entry = Core.cleanEntry(rawEntry);
      const duration = Core.durationMinutes(start, end);
      if (!entry.id || duration < 15 || duration >= Core.DAY_MINUTES
          || !Number.isInteger(duration)
          || start.getSeconds() || end.getSeconds() || start.getMilliseconds() || end.getMilliseconds()
          || Core.minutesOfDay(start) % 15 || Core.minutesOfDay(end) % 15) {
        return { ok: false, message: "备份中有不符合 15 分钟规则的记录" };
      }
      ids.add(entry.id);
      entries.push(entry);
    }
    entries.sort((a, b) => new Date(a.start) - new Date(b.start));
    for (let index = 1; index < entries.length; index += 1) {
      if (new Date(entries[index].start) < new Date(entries[index - 1].end)) {
        return { ok: false, message: "备份中的记录彼此重叠，为保护原数据未导入" };
      }
    }
    const settings = normalizeSettings(value.settings);
    if (settings.theme !== value.settings.theme
        || settings.reminderTime !== value.settings.reminderTime
        || typeof value.settings.reminderEnabled !== "boolean") {
      return { ok: false, message: "备份中的设置格式不正确" };
    }
    const normalized = normalizeState(value);
    if (normalized.categories.length !== value.categories.length
        || normalized.entries.length !== entries.length) {
      return { ok: false, message: "备份内容无法无损恢复，为保护原数据未导入" };
    }
    return { ok: true, state: normalized, count: normalized.entries.length };
  }

  function exportData() {
    ui.recoveryExportPending = false;
    const json = JSON.stringify(makeBackup(), null, 2);
    const bridge = nativeBridge();
    if (bridge && typeof bridge.exportData === "function") {
      try {
        bridge.exportData(json);
        return;
      } catch (error) { /* Use browser download below. */ }
    }
    try {
      const blob = new Blob([json], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${Edition.backup.filePrefix}备份-${Core.toLocalDateKey(new Date())}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      rememberBackup();
      showToast("备份已导出");
    } catch (error) {
      showToast("导出失败，请稍后重试");
    }
  }

  function exportRecoveryData() {
    if (!preservedRawState) {
      showToast("没有需要导出的抢救副本");
      return;
    }
    const json = JSON.stringify({
      app: Edition.backup.recoveryApp,
      version: 1,
      exportedAt: new Date().toISOString(),
      note: "这是异常本机数据的原始副本，请勿直接作为普通备份导入。",
      raw: preservedRawState,
    }, null, 2);
    const bridge = nativeBridge();
    if (bridge && typeof bridge.exportData === "function") {
      try {
        ui.recoveryExportPending = true;
        bridge.exportData(json);
        return;
      } catch (error) {
        ui.recoveryExportPending = false;
      }
    }
    try {
      const blob = new Blob([json], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${Edition.backup.filePrefix}抢救副本-${Core.toLocalDateKey(new Date())}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      recoveryProtected = true;
      showToast("原始抢救副本已导出");
    } catch (error) {
      showToast("抢救副本导出失败，请换一个位置重试");
    }
  }

  function requestImport() {
    const bridge = nativeBridge();
    if (bridge && (typeof bridge.requestImport === "function" || typeof bridge.importData === "function")) {
      try {
        (bridge.requestImport || bridge.importData).call(bridge);
        return;
      } catch (error) { /* Use file input below. */ }
    }
    $("importFile").value = "";
    $("importFile").click();
  }

  function receiveImportedData(raw) {
    if (ui.importPending) return;
    ui.importPending = true;
    try {
      const result = validateBackup(raw);
      if (!result.ok) {
        showToast(`无法导入：${result.message}`);
        return;
      }
      const confirmed = window.confirm(`备份包含 ${result.count} 条记录，将替换当前 ${state.entries.length} 条记录、分类和设置。\n\n确认导入吗？原数据不会自动保留，请先导出备份。`);
      if (!confirmed) {
        showToast("已取消导入，原数据没有变化");
        return;
      }
      const before = state;
      state = result.state;
      if (!persist()) {
        state = before;
        return;
      }
      setSelectedWeek(new Date());
      applyTheme();
      syncReminderToNative();
      renderAll();
      showToast(`已恢复 ${result.count} 条记录`);
    } finally {
      ui.importPending = false;
    }
  }

  function clearEntries() {
    const count = state.entries.length;
    if (!count) {
      showToast("目前没有记录需要清空");
      return;
    }
    if (!window.confirm(`当前共有 ${count} 条记录。清空只会删除时间记录，主题、分类和提醒会保留。\n\n要继续吗？`)) return;
    if (!window.confirm(`请再次确认：真的要清空全部 ${count} 条时间记录吗？`)) return;
    const before = clone(state.entries);
    state.entries = [];
    if (!persist()) {
      state.entries = before;
      return;
    }
    renderAll();
    withEntryUndo(`已清空 ${count} 条记录`, before);
  }

  function reportShareText() {
    const stats = weekStats(ui.selectedWeek);
    const categories = categoryTotalsSorted(stats).slice(0, 6).map(([id, minutes]) => `· ${categoryById(id).name}：${formatHours(minutes)}`);
    if (ReportExt) {
      return ReportExt.shareLines(stats, {
        formatHours, formatPercentage, categories, weekLabel: formatWeekRange(ui.selectedWeek),
      }).join("\n");
    }
    return [
      `${Edition.appName} · ${formatWeekRange(ui.selectedWeek)}`,
      `已记录 ${formatHours(stats.trackedMinutes)}，待补 ${formatHours(stats.untrackedMinutes)}`,
      `工作/学习：${formatHours(stats.workStudyMinutes)}`,
      `生活事务：${formatHours(stats.lifeMinutes)}`,
      `休息娱乐：${formatHours(stats.restLeisureMinutes)}`,
      ...(categories.length ? ["主要分类：", ...categories] : []),
      "基于当前记录，只看见时间，不评判自己。",
    ].join("\n");
  }

  async function shareReport() {
    const text = reportShareText();
    const bridge = nativeBridge();
    if (bridge && typeof bridge.shareText === "function") {
      try { bridge.shareText(text); return; } catch (error) { /* Browser fallback below. */ }
    }
    if (navigator.share) {
      try { await navigator.share({ title: Edition.appName, text }); return; } catch (error) {
        if (error && error.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast("周报摘要已复制");
    } catch (error) {
      showToast("暂时无法分享，请稍后重试");
    }
  }

  function syncReminderToNative() {
    const bridge = nativeBridge();
    if (!bridge || typeof bridge.setReminder !== "function") return;
    try { bridge.setReminder(state.settings.reminderEnabled, state.settings.reminderTime); } catch (error) {
      state.settings.reminderEnabled = false;
      persist();
      renderSettings();
      showToast("无法同步提醒，已保持关闭");
    }
  }

  function setReminder(enabled) {
    const previousEnabled = state.settings.reminderEnabled;
    state.settings.reminderEnabled = Boolean(enabled);
    if (!persist()) {
      state.settings.reminderEnabled = previousEnabled;
      renderSettings();
      return;
    }
    renderSettings();
    const bridge = nativeBridge();
    if (bridge && typeof bridge.setReminder === "function") {
      try {
        bridge.setReminder(state.settings.reminderEnabled, state.settings.reminderTime);
        return;
      } catch (error) {
        state.settings.reminderEnabled = false;
        persist();
        renderSettings();
        showToast("无法更新提醒，已保持关闭");
        return;
      }
    }
    showToast(enabled ? `已保存每天 ${state.settings.reminderTime} 的提醒设置` : "每日提醒已关闭");
  }

  function updateReminderFromAndroid(detail) {
    const value = String(detail || "");
    if (value === "off") {
      state.settings.reminderEnabled = false;
    } else if (/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      state.settings.reminderEnabled = true;
      state.settings.reminderTime = value;
    }
    persist();
    renderSettings();
  }

  function readNativeReminderState() {
    const bridge = nativeBridge();
    if (!bridge || typeof bridge.getReminderState !== "function") return;
    try {
      const native = JSON.parse(bridge.getReminderState());
      if (native && typeof native.enabled === "boolean") {
        const previous = clone(state.settings);
        const nativeTime = String(native.time || "");
        state.settings.reminderEnabled = native.enabled;
        // A disabled reminder keeps the locally chosen time as the preset for
        // its next enable. Native time is authoritative only while enabled.
        if (native.enabled && /^([01]\d|2[0-3]):[0-5]\d$/.test(nativeTime)) {
          state.settings.reminderTime = nativeTime;
        }
        if (JSON.stringify(previous) !== JSON.stringify(state.settings) && !persist()) {
          state.settings = previous;
        }
      }
    } catch (error) { /* Keep locally persisted preference. */ }
  }

  let timelineDrag = null;

  function reflectRangeSelectMode() {
    const canvas = $("timelineCanvas");
    const button = $("rangeSelectButton");
    if (canvas) canvas.classList.toggle("range-select-mode", ui.rangeSelectMode);
    if (button) {
      button.classList.toggle("active", ui.rangeSelectMode);
      button.setAttribute("aria-pressed", String(ui.rangeSelectMode));
      button.textContent = ui.rangeSelectMode ? "滑动选择" : "拖选时段";
    }
  }

  function setRangeSelectMode(enabled, announce) {
    if (!enabled) cancelTimelineDrag();
    ui.rangeSelectMode = Boolean(enabled);
    reflectRangeSelectMode();
    if (announce) {
      showToast(ui.rangeSelectMode ? "在时间轴上滑动，松开后填写记录" : "已退出拖选");
    }
  }

  function timelineMinuteAt(event) {
    const canvas = $("timelineCanvas");
    const rect = canvas.getBoundingClientRect();
    const y = Math.max(0, Math.min(rect.height - 1, event.clientY - rect.top));
    return Math.max(0, Math.min(23 * 60 + 45, Math.floor((y / 62) * 4) * 15));
  }

  function activateTimelineDrag(event) {
    if (!timelineDrag || timelineDrag.active) return;
    timelineDrag.active = true;
    timelineDrag.current = timelineMinuteAt(event);
    const canvas = $("timelineCanvas");
    try { canvas.setPointerCapture(timelineDrag.pointerId); } catch (error) { /* Capture is optional. */ }
    const marker = document.createElement("div");
    marker.className = "timeline-entry";
    marker.style.cssText = "--entry-color:#1d6e5b;pointer-events:none;z-index:8;";
    marker.setAttribute("aria-hidden", "true");
    canvas.appendChild(marker);
    timelineDrag.marker = marker;
    if (navigator.vibrate && timelineDrag.pointerType === "touch") navigator.vibrate(18);
    updateTimelineDrag(event);
  }

  function updateTimelineDrag(event) {
    if (!timelineDrag || !timelineDrag.active) return;
    timelineDrag.current = timelineMinuteAt(event);
    const start = Math.min(timelineDrag.anchor, timelineDrag.current);
    const end = Math.min(Core.DAY_MINUTES, Math.max(timelineDrag.anchor, timelineDrag.current) + 15);
    timelineDrag.selectionStart = start;
    timelineDrag.selectionEnd = end;
    timelineDrag.marker.style.top = `${(start / 60) * 62 + 2}px`;
    timelineDrag.marker.style.height = `${Math.max(22, ((end - start) / 60) * 62 - 4)}px`;
    timelineDrag.marker.innerHTML = `<strong>选择 ${Core.minutesToTime(start)}–${Core.minutesToTime(end)}</strong><span>${Core.formatDuration(end - start)} · 松开后填写</span>`;
  }

  function cancelTimelineDrag() {
    if (!timelineDrag) return;
    if (timelineDrag.marker) timelineDrag.marker.remove();
    timelineDrag = null;
  }

  function onTimelinePointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    const canvas = $("timelineCanvas");
    if (!ui.rangeSelectMode && event.target.closest(".timeline-entry")) return;
    const emptyTarget = ui.rangeSelectMode
      ? canvas.contains(event.target)
      : event.target.closest(".timeline-hour button, .timeline-hour");
    if (!emptyTarget) return;
    cancelTimelineDrag();
    timelineDrag = {
      pointerId: event.pointerId,
      pointerType: event.pointerType || "mouse",
      startX: event.clientX,
      startY: event.clientY,
      anchor: timelineMinuteAt(event),
      current: timelineMinuteAt(event),
      active: false,
      marker: null,
    };
    if (ui.rangeSelectMode) {
      event.preventDefault();
      activateTimelineDrag(event);
      return;
    }
  }

  function onTimelinePointerMove(event) {
    if (!timelineDrag || event.pointerId !== timelineDrag.pointerId) return;
    const distance = Math.hypot(event.clientX - timelineDrag.startX, event.clientY - timelineDrag.startY);
    if (!timelineDrag.active) {
      if (timelineDrag.pointerType === "touch") {
        if (distance > 10) cancelTimelineDrag();
        return;
      }
      if (distance < 6) return;
      activateTimelineDrag(event);
    }
    if (timelineDrag && timelineDrag.active) {
      event.preventDefault();
      updateTimelineDrag(event);
    }
  }

  function onTimelinePointerUp(event) {
    if (!timelineDrag || event.pointerId !== timelineDrag.pointerId) return;
    if (!timelineDrag.active) {
      timelineDrag = null;
      return;
    }
    event.preventDefault();
    updateTimelineDrag(event);
    const startMinutes = timelineDrag.selectionStart;
    const endMinutes = timelineDrag.selectionEnd;
    const marker = timelineDrag.marker;
    timelineDrag = null;
    if (marker) marker.remove();
    setRangeSelectMode(false, false);
    ui.suppressNextClick = true;
    window.setTimeout(() => { ui.suppressNextClick = false; }, 500);
    const dayStart = Core.fromLocalDateKey(ui.selectedDate);
    openEntry({ defaults: {
      start: Core.addMinutes(dayStart, startMinutes),
      end: Core.addMinutes(dayStart, endMinutes),
      categoryId: "", content: "", location: "", energy: 0, mood: 0, note: "",
    } });
  }

  function onTimelinePointerCancel(event) {
    if (timelineDrag && event.pointerId === timelineDrag.pointerId) cancelTimelineDrag();
  }

  function handleAction(action, target, event) {
    switch (action) {
      case "go-today": goCurrentWeek(true); break;
      case "go-current-week": goCurrentWeek(false); break;
      case "shift-week": {
        const offset = Number(target.dataset.offset) || 0;
        setSelectedWeek(Core.addDays(Core.fromLocalDateKey(ui.selectedWeek), offset * 7));
        renderAll();
        break;
      }
      case "show-report": navigate("report"); break;
      case "toggle-range-select": setRangeSelectMode(!ui.rangeSelectMode, true); break;
      case "share-report": shareReport(); break;
      case "select-day":
        ui.selectedDate = target.dataset.date;
        ui.selectedWeek = Core.weekKey(Core.fromLocalDateKey(ui.selectedDate));
        ui.shouldScrollTimeline = true;
        renderToday();
        break;
      case "new-entry": openEntry(); break;
      case "open-ai-import": openAiImport(); break;
      case "close-ai-import": closeAiImport(); break;
      case "go-ai-settings": closeAiImport(); navigate("settings"); newAiProfile(); break;
      case "analyze-text": analyzeDayText(); break;
      case "save-ai-drafts": saveAiDrafts(); break;
      case "add-unresolved": addUnresolved(Number(target.dataset.index)); break;
      case "new-at":
        if (ui.suppressNextClick) break;
        ui.selectedDate = target.dataset.date || ui.selectedDate;
        ui.selectedWeek = Core.weekKey(Core.fromLocalDateKey(ui.selectedDate));
        openEntry({ date: ui.selectedDate, hour: Number(target.dataset.hour) || 0 });
        break;
      case "fill-gap": {
        if (ui.suppressNextClick) break;
        const dayStart = Core.fromLocalDateKey(ui.selectedDate);
        const gapStart = Number(target.dataset.start) || 0;
        const gapEnd = Number(target.dataset.end) || gapStart + 60;
        // A pointer click carries a position; keyboard activation (detail 0) does not.
        const tapMinute = event && event.detail > 0 ? timelineMinuteAt(event) : NaN;
        const range = Core.gapPrefillRange(gapStart, gapEnd, tapMinute);
        openEntry({ defaults: {
          start: Core.addMinutes(dayStart, range.start),
          end: Core.addMinutes(dayStart, range.end),
          categoryId: "", content: "", location: "", energy: 0, mood: 0, note: "",
        } });
        break;
      }
      case "continue-last": continueLastEntry(); break;
      case "edit-entry": openEntry({ id: target.dataset.id }); break;
      case "close-entry": closeEntry(); break;
      case "save-entry": saveEntry(); break;
      case "delete-entry": deleteEntry(); break;
      case "pick-category":
        ui.selectedCategory = target.dataset.id;
        renderCategoryPicker();
        break;
      case "set-rating": {
        const root = $(target.dataset.ratingTarget);
        const value = Number(target.dataset.value) || 0;
        root.dataset.value = String(Number(root.dataset.value) === value ? 0 : value);
        renderRatings();
        break;
      }
      case "add-category": openCategorySheet(); break;
      case "close-category": closeCategorySheet(); break;
      case "pick-color":
        ui.selectedColor = safeColor(target.dataset.color);
        renderColorPicker();
        break;
      case "save-category": saveCategory(); break;
      case "delete-category": deleteCategory(target.dataset.id); break;
      case "export-data": exportData(); break;
      case "export-recovery": exportRecoveryData(); break;
      case "import-data": requestImport(); break;
      case "clear-data": clearEntries(); break;
      case "save-ai-profile": saveAiProfile(); break;
      case "new-ai-profile": newAiProfile(); break;
      case "close-ai-profile-editor": closeAiProfileEditor(); break;
      case "edit-ai-profile": editAiProfile(target.dataset.id); break;
      case "delete-ai-profile": deleteAiProfile(target.dataset.id); break;
      case "activate-ai-profile": activateAiProfile(target.dataset.id); break;
      case "test-ai-profile": testAiProfile(target.dataset.id); break;
      case "open-history-week":
        setSelectedWeek(Core.fromLocalDateKey(target.dataset.week));
        navigate("week");
        break;
      default: break;
    }
  }

  function onDocumentClick(event) {
    const nav = event.target.closest("[data-nav]");
    if (nav) {
      navigate(nav.dataset.nav);
      return;
    }
    const theme = event.target.closest("[data-theme-choice]");
    if (theme) {
      const previousTheme = state.settings.theme;
      state.settings.theme = theme.dataset.themeChoice;
      if (!persist()) {
        state.settings.theme = previousTheme;
        applyTheme();
        return;
      }
      applyTheme();
      return;
    }
    const duration = event.target.closest("[data-duration]");
    if (duration) {
      setEntryDuration(duration.dataset.duration);
      return;
    }
    const actionTarget = event.target.closest("[data-action]");
    if (actionTarget) handleAction(actionTarget.dataset.action, actionTarget, event);
  }

  function onFileSelected(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      showToast("备份文件过大，未导入");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => receiveImportedData(String(reader.result || ""));
    reader.onerror = () => showToast("无法读取这个文件");
    reader.readAsText(file, "utf-8");
  }

  function activeSheet() {
    if (!$("categorySheet").classList.contains("hidden")) return $("categorySheet");
    if (!$("aiSheet").classList.contains("hidden")) return $("aiSheet");
    if (!$("entrySheet").classList.contains("hidden")) return $("entrySheet");
    return null;
  }

  function focusableIn(root) {
    return all('button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])', root)
      .filter((element) => {
        if (element.hidden || element.closest(".hidden") || element.getClientRects().length === 0) return false;
        const closedDetails = element.closest("details:not([open])");
        return !closedDetails || element.tagName === "SUMMARY";
      });
  }

  function onDocumentKeydown(event) {
    const sheet = activeSheet();
    if (!sheet) {
      if (event.key === "Escape" && ui.view === "settings" && ui.aiEditorOpen) {
        event.preventDefault();
        closeAiProfileEditor();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (sheet.id === "categorySheet") closeCategorySheet();
      else if (sheet.id === "aiSheet") closeAiImport();
      else closeEntry();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = focusableIn(sheet);
    if (!focusable.length) {
      event.preventDefault();
      sheet.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const outside = !sheet.contains(document.activeElement) || document.activeElement === sheet;
    if (event.shiftKey && (outside || document.activeElement === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (outside || document.activeElement === last)) {
      event.preventDefault();
      first.focus();
    }
  }

  function refreshDayBoundary() {
    const todayKey = Core.toLocalDateKey(new Date());
    if (todayKey === ui.lastTodayKey) return;
    const followedToday = ui.selectedDate === ui.lastTodayKey;
    ui.lastTodayKey = todayKey;
    if (followedToday) {
      ui.selectedDate = todayKey;
      ui.selectedWeek = Core.weekKey(Core.fromLocalDateKey(todayKey));
      ui.shouldScrollTimeline = true;
      renderAll();
    }
  }

  function scheduleDayBoundaryRefresh() {
    window.clearTimeout(ui.dayBoundaryTimer);
    const nextDay = new Date();
    nextDay.setHours(24, 0, 1, 0);
    ui.dayBoundaryTimer = window.setTimeout(() => {
      refreshDayBoundary();
      scheduleDayBoundaryRefresh();
    }, Math.max(1000, nextDay.getTime() - Date.now()));
  }

  function installEvents() {
    const quickPanel = $("quickPanel");
    // applyEdition() has already hidden the variant this edition does not use.
    const manualEntry = quickPanel && Array.from(quickPanel.querySelectorAll('[data-action="new-entry"]'))
      .find((button) => !button.hidden);
    if (manualEntry && typeof window.IntersectionObserver === "function") {
      const topBarHeight = Math.ceil(document.querySelector(".topbar").getBoundingClientRect().height);
      const navHeight = Math.ceil(document.querySelector(".bottom-nav").getBoundingClientRect().height);
      const observer = new window.IntersectionObserver((entries) => {
        ui.quickPanelVisible = entries[0].isIntersecting && entries[0].intersectionRatio >= 0.5;
        updateFloatingAddVisibility();
      }, { rootMargin: `-${topBarHeight}px 0px -${navHeight}px 0px`, threshold: 0.5 });
      observer.observe(manualEntry);
    } else {
      ui.quickPanelVisible = false;
    }
    document.addEventListener("click", onDocumentClick);
    document.addEventListener("keydown", onDocumentKeydown);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        refreshDayBoundary();
        scheduleDayBoundaryRefresh();
      }
    });
    window.addEventListener("pageshow", refreshDayBoundary);
    window.addEventListener("focus", refreshDayBoundary);
    $("entryBackdrop").addEventListener("click", closeEntry);
    $("aiBackdrop").addEventListener("click", closeAiImport);
    $("categoryBackdrop").addEventListener("click", closeCategorySheet);
    $("aiDraftList").addEventListener("input", onAiDraftChange);
    $("aiDraftList").addEventListener("change", onAiDraftChange);
    ["aiDate", "aiText"].forEach((id) => $(id).addEventListener("input", () => {
      clearAiResult();
      storeAiDraftText();
    }));
    $("entryForm").addEventListener("submit", (event) => event.preventDefault());
    ["entryDate", "entryStart", "entryEnd"].forEach((id) => $(id).addEventListener("input", updateDurationHelper));
    $("newCategoryName").addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); saveCategory(); }
    });
    $("themeSelector").addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      const choices = all("[data-theme-choice]", event.currentTarget);
      const current = Math.max(0, choices.indexOf(document.activeElement));
      let next = current;
      if (event.key === "Home") next = 0;
      else if (event.key === "End") next = choices.length - 1;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (current - 1 + choices.length) % choices.length;
      else next = (current + 1) % choices.length;
      event.preventDefault();
      choices[next].focus();
      choices[next].click();
    });
    $("reminderEnabled").addEventListener("change", (event) => setReminder(event.target.checked));
    $("aiProvider").addEventListener("change", onAiProviderChange);
    $("aiEndpoint").addEventListener("input", updateAiProviderView);
    $("aiModelSelect").addEventListener("change", onAiSettingsModelChange);
    $("aiImportProfile").addEventListener("change", () => {
      renderAiImportModels();
      clearAiResult();
    });
    $("aiImportModel").addEventListener("change", onAiImportModelChange);
    $("aiImportCustomModel").addEventListener("input", () => { updateAiRecognitionSummary(); clearAiResult(); });
    $("aiDeepThinking").addEventListener("change", updateAiRecognitionSummary);
    $("reminderTime").addEventListener("change", (event) => {
      const value = event.target.value;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
        event.target.value = state.settings.reminderTime;
        showToast("请选择有效的提醒时间");
        return;
      }
      const previousTime = state.settings.reminderTime;
      state.settings.reminderTime = value;
      if (!persist()) {
        state.settings.reminderTime = previousTime;
        event.target.value = previousTime;
        return;
      }
      if (state.settings.reminderEnabled) syncReminderToNative();
    });
    $("importFile").addEventListener("change", onFileSelected);
    const canvas = $("timelineCanvas");
    canvas.addEventListener("pointerdown", onTimelinePointerDown);
    canvas.addEventListener("pointermove", onTimelinePointerMove, { passive: false });
    canvas.addEventListener("pointerup", onTimelinePointerUp, { passive: false });
    canvas.addEventListener("pointercancel", onTimelinePointerCancel);
    window.addEventListener("android-import-complete", (event) => receiveImportedData(event.detail));
    window.addEventListener("android-ai-result", (event) => receiveAiResult(event.detail));
    window.addEventListener("android-ai-profile-test", (event) => receiveAiProfileTest(event.detail));
    window.addEventListener("android-import-error", () => showToast("无法读取备份，原数据没有变化"));
    window.addEventListener("android-export-complete", () => {
      const recoveryExport = ui.recoveryExportPending;
      ui.recoveryExportPending = false;
      if (recoveryExport) recoveryProtected = true;
      else rememberBackup();
      showToast(recoveryExport ? "原始抢救副本已保存" : "备份已保存");
    });
    window.addEventListener("android-export-error", () => {
      const recoveryExport = ui.recoveryExportPending;
      ui.recoveryExportPending = false;
      showToast(recoveryExport ? "抢救副本保存失败，请换一个位置重试" : "备份保存失败，请换一个位置重试");
    });
    window.addEventListener("android-export-cancelled", () => {
      const recoveryExport = ui.recoveryExportPending;
      ui.recoveryExportPending = false;
      showToast(recoveryExport ? "已取消抢救副本导出" : "已取消导出");
    });
    window.addEventListener("android-reminder-updated", (event) => updateReminderFromAndroid(event.detail));
    window.addEventListener("android-system-theme", () => { if (state.settings.theme === "system") applyTheme(); });
    window.addEventListener("android-reminder-permission", (event) => {
      if (String(event.detail) === "denied") {
        state.settings.reminderEnabled = false;
        persist();
        renderSettings();
        showToast("未获得通知权限，提醒已保持关闭");
      }
    });
    window.addEventListener("android-reminder-error", () => {
      state.settings.reminderEnabled = false;
      persist();
      renderSettings();
      showToast("提醒设置无效，已保持关闭");
    });
  }

  window.handleAndroidBack = function () {
    if (!$("categorySheet").classList.contains("hidden")) {
      closeCategorySheet();
      return true;
    }
    if (!$("aiSheet").classList.contains("hidden")) {
      closeAiImport();
      return true;
    }
    if (!$("entrySheet").classList.contains("hidden")) {
      closeEntry();
      return true;
    }
    if (ui.rangeSelectMode) {
      setRangeSelectMode(false, false);
      return true;
    }
    if (ui.view === "settings" && ui.aiEditorOpen) {
      closeAiProfileEditor();
      return true;
    }
    if (ui.view !== "today") {
      navigate("today");
      return true;
    }
    if (ui.selectedWeek !== Core.weekKey(new Date()) || ui.selectedDate !== Core.toLocalDateKey(new Date())) {
      goCurrentWeek(true);
      return true;
    }
    return false;
  };

  // One markup serves every edition: hide what this edition does not ship and
  // fill in its name and wording. Hidden controls keep their ids, so shared
  // code paths never meet a missing element.
  function applyEdition() {
    document.title = Edition.appName;
    all("[data-feature]").forEach((element) => {
      if (!FEATURES[element.dataset.feature]) element.hidden = true;
    });
    all("[data-feature-off]").forEach((element) => {
      if (FEATURES[element.dataset.featureOff]) element.hidden = true;
    });
    const reportSlot = $("editionReportSlot");
    if (ReportExt && reportSlot) {
      reportSlot.innerHTML = ReportExt.markup;
      all("[data-default-report]").forEach((element) => { element.hidden = true; });
    }
    // Daily reminders need the Android shell; the web build explains instead.
    const native = Boolean(nativeBridge());
    all("[data-native-only]").forEach((element) => { if (!native) element.hidden = true; });
    all("[data-web-only]").forEach((element) => { if (native) element.hidden = true; });
    all("[data-edition-name]").forEach((element) => { element.textContent = Edition.appName; });
    all("[data-edition-version]").forEach((element) => { element.textContent = `v${Edition.version}`; });
    all("[data-edition-text]").forEach((element) => {
      const value = Edition.text[element.dataset.editionText];
      if (typeof value === "string") element.textContent = value;
    });
    all("[data-edition-placeholder]").forEach((element) => {
      const value = Edition.text[element.dataset.editionPlaceholder];
      if (typeof value === "string") element.placeholder = value;
    });
  }

  function rememberBackup() {
    try { localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString()); } catch (error) { /* Optional. */ }
  }

  // In a plain browser the records live only in this origin's storage, which
  // the browser may evict. Ask for persistent storage and, at most once a
  // day, nudge towards an export when the last one is old or missing.
  function protectWebStorage() {
    if (nativeBridge()) return;
    const storage = navigator.storage;
    if (storage && typeof storage.persist === "function" && typeof storage.persisted === "function") {
      storage.persisted().then((granted) => granted || storage.persist()).catch(() => {});
    }
    if (!state.entries.length || startupWarning) return;
    try {
      const today = Core.toLocalDateKey(new Date());
      if (localStorage.getItem(LAST_NUDGE_KEY) === today) return;
      const last = Date.parse(localStorage.getItem(LAST_BACKUP_KEY) || "");
      if (Number.isFinite(last) && Date.now() - last < BACKUP_NUDGE_DAYS * 86400000) return;
      localStorage.setItem(LAST_NUDGE_KEY, today);
      window.requestAnimationFrame(() => showToast("网页版记录只在这个浏览器里，记得到设置里导出备份"));
    } catch (error) { /* Storage unavailable: the settings note still explains. */ }
  }

  function init() {
    applyEdition();
    installEvents();
    readNativeReminderState();
    if (needsInitialPersist) {
      persist();
      needsInitialPersist = false;
    }
    applyTheme();
    renderAll();
    scheduleDayBoundaryRefresh();
    protectWebStorage();
    if (startupWarning) window.requestAnimationFrame(() => showToast(startupWarning));
    const media = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
    if (media) {
      const listener = () => { if (state.settings.theme === "system") applyTheme(); };
      if (typeof media.addEventListener === "function") media.addEventListener("change", listener);
      else if (typeof media.addListener === "function") media.addListener(listener);
    }
  }

  window.receiveImportedData = receiveImportedData;
  window.__Time168App = {
    getState: () => clone(state),
    setState: (value) => { state = normalizeState(value); persist(); renderAll(); },
    normalizeState,
    makeBackup,
    validateBackup,
    receiveImportedData,
    renderAll,
    STORAGE_KEY,
    RECOVERY_KEY,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();

})();
