(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.Time168Core = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const QUARTER_MINUTES = 15;
  const DAY_MINUTES = 24 * 60;
  const WEEK_MINUTES = 7 * DAY_MINUTES;

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function asDate(value) {
    if (typeof value === "string") {
      const localKey = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      if (localKey) {
        const year = Number(localKey[1]);
        const month = Number(localKey[2]) - 1;
        const day = Number(localKey[3]);
        const localDate = new Date(0);
        localDate.setHours(0, 0, 0, 0);
        localDate.setFullYear(year, month, day);
        return localDate.getFullYear() === year
          && localDate.getMonth() === month
          && localDate.getDate() === day ? localDate : null;
      }
    }
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function toLocalDateKey(value) {
    const date = asDate(value);
    if (!date) return "";
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function fromLocalDateKey(key, minutes) {
    const date = asDate(String(key || ""));
    if (!date) return null;
    if (Number.isFinite(minutes)) date.setMinutes(minutes);
    return date;
  }

  function startOfWeek(value) {
    const date = asDate(value) || new Date();
    date.setHours(0, 0, 0, 0);
    const mondayDistance = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - mondayDistance);
    return date;
  }

  function addDays(value, amount) {
    const date = asDate(value);
    if (!date) return null;
    date.setDate(date.getDate() + Number(amount || 0));
    return date;
  }

  function addMinutes(value, amount) {
    const date = asDate(value);
    if (!date) return null;
    date.setMinutes(date.getMinutes() + Number(amount || 0));
    return date;
  }

  function weekKey(value) {
    return toLocalDateKey(startOfWeek(value));
  }

  function weekRange(value) {
    const start = startOfWeek(value);
    return { start, end: addDays(start, 7) };
  }

  function minutesOfDay(value) {
    const date = asDate(value);
    if (!date) return 0;
    return date.getHours() * 60 + date.getMinutes();
  }

  function roundToQuarter(value, mode) {
    const date = asDate(value) || new Date();
    const raw = date.getMinutes() / QUARTER_MINUTES;
    let rounded;
    if (mode === "floor") rounded = Math.floor(raw);
    else if (mode === "ceil") rounded = Math.ceil(raw);
    else rounded = Math.round(raw);
    date.setMinutes(rounded * QUARTER_MINUTES, 0, 0);
    return date;
  }

  function parseTime(value) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return hours * 60 + minutes;
  }

  function minutesToTime(minutes) {
    let safe = Number(minutes);
    if (!Number.isFinite(safe)) safe = 0;
    safe = ((Math.round(safe) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
    return `${pad2(Math.floor(safe / 60))}:${pad2(safe % 60)}`;
  }

  function durationMinutes(start, end) {
    const a = asDate(start);
    const b = asDate(end);
    if (!a || !b) return 0;
    return Math.max(0, Math.round((b.getTime() - a.getTime()) / 60000));
  }

  function overlapMinutes(startA, endA, startB, endB) {
    const a1 = asDate(startA);
    const a2 = asDate(endA);
    const b1 = asDate(startB);
    const b2 = asDate(endB);
    if (!a1 || !a2 || !b1 || !b2) return 0;
    return Math.max(0, Math.round((Math.min(a2, b2) - Math.max(a1, b1)) / 60000));
  }

  function mergeIntervals(intervals) {
    const sorted = (intervals || [])
      .map((item) => ({ start: asDate(item.start), end: asDate(item.end) }))
      .filter((item) => item.start && item.end && item.end > item.start)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    sorted.forEach((item) => {
      const last = merged[merged.length - 1];
      if (!last || item.start > last.end) {
        merged.push({ start: item.start, end: item.end });
      } else if (item.end > last.end) {
        last.end = item.end;
      }
    });
    return merged;
  }

  const LONG_GAP_MINUTES = 3 * 60;

  // Range to prefill when a "待补" gap is tapped (minutes from day start).
  // Short gaps are usually one activity, so the whole gap is offered. Long
  // gaps (e.g. a fully untracked morning) would turn one careless tap into a
  // 15-hour record, so only the tapped hour is offered; without a tap
  // position (keyboard), the hour closest to now — the gap's end — is used.
  function gapPrefillRange(gapStart, gapEnd, tapMinute) {
    if (gapEnd - gapStart <= LONG_GAP_MINUTES) return { start: gapStart, end: gapEnd };
    const anchor = Number.isFinite(tapMinute) ? Math.floor(tapMinute / 60) * 60 : gapEnd - 60;
    const start = Math.max(gapStart, Math.min(anchor, gapEnd - 60));
    return { start, end: Math.min(gapEnd, start + 60) };
  }

  function subtractIntervals(start, end, blocked) {
    const rangeStart = asDate(start);
    const rangeEnd = asDate(end);
    if (!rangeStart || !rangeEnd || rangeEnd <= rangeStart) return [];
    const relevant = mergeIntervals(
      (blocked || [])
        .map((item) => ({
          start: new Date(Math.max(rangeStart, asDate(item.start) || rangeEnd)),
          end: new Date(Math.min(rangeEnd, asDate(item.end) || rangeStart)),
        }))
        .filter((item) => item.end > item.start)
    );
    const free = [];
    let cursor = rangeStart;
    relevant.forEach((item) => {
      if (item.start > cursor) free.push({ start: new Date(cursor), end: new Date(item.start) });
      if (item.end > cursor) cursor = item.end;
    });
    if (cursor < rangeEnd) free.push({ start: new Date(cursor), end: new Date(rangeEnd) });
    return free;
  }

  function makeId(prefix) {
    return `${prefix || "e"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function isValidEntry(entry) {
    if (!entry || typeof entry !== "object") return false;
    const start = asDate(entry.start);
    const end = asDate(entry.end);
    return Boolean(start && end && end > start && typeof entry.categoryId === "string");
  }

  function cleanEntry(entry) {
    const start = asDate(entry.start);
    const end = asDate(entry.end);
    return {
      id: String(entry.id || makeId()),
      start: start ? start.toISOString() : "",
      end: end ? end.toISOString() : "",
      categoryId: String(entry.categoryId || "other").slice(0, 80),
      content: String(entry.content || "").slice(0, 160),
      location: String(entry.location || "").slice(0, 80),
      energy: Math.min(5, Math.max(0, Number(entry.energy) || 0)),
      mood: Math.min(5, Math.max(0, Number(entry.mood) || 0)),
      note: String(entry.note || "").slice(0, 1200),
      createdAt: String(entry.createdAt || new Date().toISOString()),
      updatedAt: String(entry.updatedAt || new Date().toISOString()),
    };
  }

  function upsertEntry(entries, candidate) {
    const source = Array.isArray(entries) ? entries.filter(isValidEntry).map(cleanEntry) : [];
    if (!isValidEntry(candidate)) {
      return { entries: source, added: [], trimmedMinutes: 0, noSpace: true };
    }
    const clean = cleanEntry(candidate);
    const isEdit = source.some((item) => item.id === clean.id);
    const candidateStart = new Date(clean.start);
    const candidateEnd = new Date(clean.end);
    let trimmedMinutes = 0;
    const preserved = [];

    source
      .filter((item) => item.id !== clean.id)
      .forEach((item) => {
        const oldStart = new Date(item.start);
        const oldEnd = new Date(item.end);
        const overlap = overlapMinutes(oldStart, oldEnd, candidateStart, candidateEnd);
        if (!overlap) {
          preserved.push(item);
          return;
        }
        trimmedMinutes += overlap;
        if (oldStart < candidateStart) {
          preserved.push({
            ...item,
            end: candidateStart.toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
        if (oldEnd > candidateEnd) {
          preserved.push({
            ...item,
            id: oldStart < candidateStart ? makeId(`${item.id}-part`) : item.id,
            start: candidateEnd.toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
      });

    const added = [{
      ...clean,
      createdAt: isEdit ? clean.createdAt : (clean.createdAt || new Date().toISOString()),
      updatedAt: new Date().toISOString(),
    }];
    const result = preserved.concat(added).sort((a, b) => new Date(a.start) - new Date(b.start));
    return {
      entries: result,
      added,
      trimmedMinutes,
      noSpace: false,
    };
  }

  function normalizeEntries(entries) {
    const sorted = (Array.isArray(entries) ? entries : [])
      .filter(isValidEntry)
      .map(cleanEntry)
      .sort((a, b) => new Date(a.start) - new Date(b.start) || new Date(a.end) - new Date(b.end));

    // Duplicate ids cannot be produced by the UI and are rejected on import.
    // If local storage is externally corrupted, keep only the last sorted
    // occurrence so recovery remains deterministic and bounded.
    const lastIndexById = new Map();
    sorted.forEach((entry, index) => lastIndexById.set(entry.id, index));
    const items = sorted
      .filter((entry, index) => lastIndexById.get(entry.id) === index)
      .map((entry, priority) => ({ entry, priority, active: false }));
    if (!items.length) return [];

    const events = [];
    items.forEach((item) => {
      events.push({ time: new Date(item.entry.start).getTime(), start: true, item });
      events.push({ time: new Date(item.entry.end).getTime(), start: false, item });
    });
    events.sort((a, b) => a.time - b.time);

    // Max-heap by input priority. Lazy removal keeps the sweep O(n log n),
    // even for a large imported history with many overlapping intervals.
    const heap = [];
    const swap = (a, b) => { const value = heap[a]; heap[a] = heap[b]; heap[b] = value; };
    const heapPush = (item) => {
      heap.push(item);
      let index = heap.length - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (heap[parent].priority >= heap[index].priority) break;
        swap(parent, index);
        index = parent;
      }
    };
    const heapPop = () => {
      if (heap.length === 1) return heap.pop();
      const top = heap[0];
      heap[0] = heap.pop();
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let largest = index;
        if (left < heap.length && heap[left].priority > heap[largest].priority) largest = left;
        if (right < heap.length && heap[right].priority > heap[largest].priority) largest = right;
        if (largest === index) break;
        swap(index, largest);
        index = largest;
      }
      return top;
    };
    const activeTop = () => {
      while (heap.length && !heap[0].active) heapPop();
      return heap[0] || null;
    };

    const normalized = [];
    const usedIds = new Set();
    let previousTime = events[0].time;
    let cursor = 0;
    while (cursor < events.length) {
      const time = events[cursor].time;
      const top = activeTop();
      if (top && time > previousTime) {
        const last = normalized[normalized.length - 1];
        if (last && last.sourcePriority === top.priority
            && new Date(last.entry.end).getTime() === previousTime) {
          last.entry.end = new Date(time).toISOString();
        } else {
          let id = top.entry.id;
          if (usedIds.has(id)) id = makeId(`${id}-part`);
          usedIds.add(id);
          normalized.push({
            sourcePriority: top.priority,
            entry: {
              ...top.entry,
              id,
              start: new Date(previousTime).toISOString(),
              end: new Date(time).toISOString(),
            },
          });
        }
      }

      let groupEnd = cursor;
      while (groupEnd < events.length && events[groupEnd].time === time) groupEnd += 1;
      for (let index = cursor; index < groupEnd; index += 1) {
        if (!events[index].start) events[index].item.active = false;
      }
      for (let index = cursor; index < groupEnd; index += 1) {
        if (events[index].start) {
          events[index].item.active = true;
          heapPush(events[index].item);
        }
      }
      previousTime = time;
      cursor = groupEnd;
    }
    return normalized.map((item) => item.entry);
  }

  function intervalUnionMinutes(intervals) {
    return mergeIntervals(intervals).reduce((sum, item) => sum + durationMinutes(item.start, item.end), 0);
  }

  function entriesInRange(entries, start, end) {
    const rangeStart = asDate(start);
    const rangeEnd = asDate(end);
    if (!rangeStart || !rangeEnd) return [];
    return (entries || []).filter(
      (entry) => isValidEntry(entry) && new Date(entry.end) > rangeStart && new Date(entry.start) < rangeEnd
    );
  }

  function weekStats(entries, weekValue, categories) {
    const range = weekRange(weekValue);
    const relevant = entriesInRange(entries, range.start, range.end);
    const totals = Object.create(null);
    const intervals = [];
    const dayMinutes = Array(7).fill(0);
    let energyWeighted = 0;
    let energyMinutes = 0;
    let moodWeighted = 0;
    let moodMinutes = 0;

    relevant.forEach((entry) => {
      const start = new Date(Math.max(new Date(entry.start), range.start));
      const end = new Date(Math.min(new Date(entry.end), range.end));
      const minutes = durationMinutes(start, end);
      if (!minutes) return;
      totals[entry.categoryId] = (totals[entry.categoryId] || 0) + minutes;
      intervals.push({ start, end });
      if (entry.energy) {
        energyWeighted += entry.energy * minutes;
        energyMinutes += minutes;
      }
      if (entry.mood) {
        moodWeighted += entry.mood * minutes;
        moodMinutes += minutes;
      }
      for (let day = 0; day < 7; day += 1) {
        const dayStart = addDays(range.start, day);
        const dayEnd = addDays(dayStart, 1);
        dayMinutes[day] += overlapMinutes(start, end, dayStart, dayEnd);
      }
    });

    const categoryList = Array.isArray(categories) ? categories : [];
    const categoryMap = Object.create(null);
    categoryList.forEach((category) => { categoryMap[category.id] = category; });
    const idsWithFlag = (flag) => categoryList.filter((category) => category[flag]).map((category) => category.id);
    const sumIds = (ids) => ids.reduce((sum, id) => sum + (totals[id] || 0), 0);
    const trackedMinutes = intervalUnionMinutes(intervals);

    return {
      weekStart: range.start,
      weekEnd: range.end,
      relevant,
      totals,
      categoryMap,
      trackedMinutes,
      untrackedMinutes: Math.max(0, WEEK_MINUTES - trackedMinutes),
      sleepMinutes: sumIds(idsWithFlag("sleep").length ? idsWithFlag("sleep") : ["sleep"]),
      // Low mood is observed separately and must never be framed as
      // low-quality consumption.
      lowQualityMinutes: sumIds(idsWithFlag("lowQuality").length ? idsWithFlag("lowQuality") : ["phone"]),
      energyAverage: energyMinutes ? energyWeighted / energyMinutes : null,
      moodAverage: moodMinutes ? moodWeighted / moodMinutes : null,
      // General-edition dimensions; unknown ids simply contribute zero.
      workStudyMinutes: sumIds(["work", "study"]),
      lifeMinutes: sumIds(["commute", "routine"]),
      restLeisureMinutes: sumIds(["rest", "leisure"]),
      dayMinutes,
    };
  }

  function dominantCategoryForRange(entries, start, end) {
    const totals = Object.create(null);
    entriesInRange(entries, start, end).forEach((entry) => {
      totals[entry.categoryId] = (totals[entry.categoryId] || 0) + overlapMinutes(entry.start, entry.end, start, end);
    });
    return Object.keys(totals).sort((a, b) => totals[b] - totals[a])[0] || "";
  }

  function quarterCategoryGrid(entries, weekValue) {
    const range = weekRange(weekValue);
    const startMs = range.start.getTime();
    const endMs = range.end.getTime();
    const quarterMs = QUARTER_MINUTES * 60 * 1000;
    const slotCount = WEEK_MINUTES / QUARTER_MINUTES;
    const slotTotals = Array(slotCount).fill(null);
    entriesInRange(entries, range.start, range.end).forEach((entry) => {
      const entryStart = Math.max(startMs, new Date(entry.start).getTime());
      const entryEnd = Math.min(endMs, new Date(entry.end).getTime());
      const first = Math.max(0, Math.floor((entryStart - startMs) / quarterMs));
      const last = Math.min(slotCount, Math.ceil((entryEnd - startMs) / quarterMs));
      for (let index = first; index < last; index += 1) {
        const slotStart = startMs + index * quarterMs;
        const slotEnd = slotStart + quarterMs;
        const milliseconds = Math.max(0, Math.min(entryEnd, slotEnd) - Math.max(entryStart, slotStart));
        if (!milliseconds) continue;
        if (!slotTotals[index]) slotTotals[index] = new Map();
        const totals = slotTotals[index];
        totals.set(entry.categoryId, (totals.get(entry.categoryId) || 0) + milliseconds);
      }
    });
    return slotTotals.map((totals) => {
      if (!totals) return "";
      let winner = "";
      let winnerMilliseconds = -1;
      totals.forEach((milliseconds, id) => {
        if (milliseconds > winnerMilliseconds) {
          winner = id;
          winnerMilliseconds = milliseconds;
        }
      });
      return winner;
    });
  }

  function formatDuration(minutes, compact) {
    const value = Math.max(0, Math.round(Number(minutes) || 0));
    const hours = Math.floor(value / 60);
    const rest = value % 60;
    if (compact) {
      if (!hours) return `${rest}分`;
      if (!rest) return `${hours}小时`;
      return `${hours}时${rest}分`;
    }
    if (!hours) return `${rest} 分钟`;
    if (!rest) return `${hours} 小时`;
    return `${hours} 小时 ${rest} 分钟`;
  }

  return {
    QUARTER_MINUTES,
    DAY_MINUTES,
    WEEK_MINUTES,
    asDate,
    toLocalDateKey,
    fromLocalDateKey,
    startOfWeek,
    addDays,
    addMinutes,
    weekKey,
    weekRange,
    minutesOfDay,
    roundToQuarter,
    parseTime,
    minutesToTime,
    durationMinutes,
    overlapMinutes,
    mergeIntervals,
    subtractIntervals,
    gapPrefillRange,
    makeId,
    isValidEntry,
    cleanEntry,
    upsertEntry,
    normalizeEntries,
    intervalUnionMinutes,
    entriesInRange,
    weekStats,
    dominantCategoryForRange,
    quarterCategoryGrid,
    formatDuration,
  };
});
