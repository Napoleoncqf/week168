(function (root, factory) {
  const api = factory(root.Time168Core || require("./core.js"));
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.Time168TextImport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Core) {
  "use strict";

  const MAX_ITEMS = 48;
  const QUARTER_TIME = /^([01]\d|2[0-3]):(00|15|30|45)$/;

  function cleanJsonText(value) {
    let text = String(value || "").trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    }
    return text;
  }

  function parseResponse(value) {
    let result;
    try {
      result = typeof value === "string" ? JSON.parse(cleanJsonText(value)) : value;
    } catch (error) {
      const text = cleanJsonText(value);
      // An object that opens but never closes was cut off at the output limit.
      if (text.startsWith("{") && !text.endsWith("}")) {
        return { ok: false, message: "识别结果被截断，请把这天分成上午、下午等几段分别识别" };
      }
      return { ok: false, message: "模型没有返回可识别的 JSON，请重试或换一个模型" };
    }
    if (!result || typeof result !== "object" || Array.isArray(result)
        || !Array.isArray(result.items) || result.items.length > MAX_ITEMS) {
      return { ok: false, message: "识别结果结构不正确或超过 48 段" };
    }
    const drafts = result.items.map((item) => ({
      selected: true,
      start: item && typeof item.start === "string" ? item.start.trim().slice(0, 16) : "",
      end: item && typeof item.end === "string" ? item.end.trim().slice(0, 16) : "",
      categoryId: item && typeof item.categoryId === "string" ? item.categoryId.trim().slice(0, 80) : "",
      content: item && typeof item.content === "string" ? item.content.trim().slice(0, 160) : "",
      inferred: Boolean(item && item.inferred === true),
    }));
    const unresolved = (Array.isArray(result.unresolved) ? result.unresolved : [])
      .slice(0, MAX_ITEMS)
      .map((item) => ({
        text: String(item && item.text || "").trim().slice(0, 160),
        reason: String(item && item.reason || "时间不明确").trim().slice(0, 160),
      })).filter((item) => item.text);
    return { ok: true, drafts, unresolved };
  }

  function timeRange(dateKey, draft) {
    if (!Core.fromLocalDateKey(dateKey)) return { error: "日期无效" };
    if (!QUARTER_TIME.test(draft.start || "")) return { error: "开始时间须为 15 分钟刻度" };
    if (!QUARTER_TIME.test(draft.end || "") && draft.end !== "24:00") {
      return { error: "结束时间须为 15 分钟刻度" };
    }
    const startMinutes = Core.parseTime(draft.start);
    const endMinutes = draft.end === "24:00" ? 1440 : Core.parseTime(draft.end);
    if (startMinutes == null || endMinutes == null) return { error: "时间格式不正确" };
    if (startMinutes === endMinutes) return { error: "开始和结束不能相同" };
    const start = Core.fromLocalDateKey(dateKey, startMinutes);
    let end = Core.fromLocalDateKey(dateKey, endMinutes);
    if (endMinutes < startMinutes) end = Core.addDays(end, 1);
    const duration = Core.durationMinutes(start, end);
    if (duration < 15 || duration >= Core.DAY_MINUTES) return { error: "单段必须在 15 分钟到 24 小时以内" };
    return { start, end };
  }

  function validateDrafts(dateKey, drafts, categories, existingEntries, now) {
    const ids = new Set((categories || []).map((category) => category.id));
    const errors = [];
    const candidates = [];
    const selected = (drafts || []).filter((draft) => draft.selected);
    selected.forEach((draft) => {
      const index = drafts.indexOf(draft);
      const range = timeRange(dateKey, draft);
      let error = range.error || "";
      if (!error && !ids.has(draft.categoryId)) error = "请选择有效分类";
      if (!error && range.end > (now || new Date())) error = "尚未发生的时间不能记为实际活动";
      if (!error && (existingEntries || []).some((entry) =>
        Core.overlapMinutes(range.start, range.end, entry.start, entry.end) > 0)) {
        error = "与已有记录重叠，请调整或取消勾选";
      }
      if (!error && candidates.some((candidate) =>
        Core.overlapMinutes(range.start, range.end, candidate.start, candidate.end) > 0)) {
        error = "与另一条待保存记录重叠";
      }
      if (error) {
        errors.push({ index, message: error });
        return;
      }
      candidates.push({
        start: range.start.toISOString(),
        end: range.end.toISOString(),
        categoryId: draft.categoryId,
        content: String(draft.content || "").trim().slice(0, 160),
      });
    });
    return { candidates, errors, selectedCount: selected.length };
  }

  return { MAX_ITEMS, parseResponse, timeRange, validateDrafts };
});

