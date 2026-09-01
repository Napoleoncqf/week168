"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const path = require("node:path");
const Core = require("../android/app/src/main/assets/core.js");

function local(date, time) {
  const minutes = Core.parseTime(time);
  return Core.fromLocalDateKey(date, minutes);
}

function entry(id, date, start, end, categoryId, extra) {
  const startDate = local(date, start);
  let endDate = local(date, end);
  if (endDate <= startDate) endDate = Core.addDays(endDate, 1);
  return {
    id,
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    categoryId,
    ...(extra || {}),
  };
}

function minutes(entries) {
  return entries.reduce((sum, item) => sum + Core.durationMinutes(item.start, item.end), 0);
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

run("Monday is the week start", () => {
  assert.equal(Core.weekKey(local("2026-08-30", "12:00")), "2026-08-24");
  assert.equal(Core.weekKey(local("2026-08-31", "12:00")), "2026-08-31");
  assert.equal(Core.fromLocalDateKey("2026-02-30"), null);
});

run("plain date keys stay local outside the China timezone", () => {
  const corePath = path.resolve(__dirname, "../android/app/src/main/assets/core.js");
  const output = childProcess.execFileSync(process.execPath, [
    "-e",
    `const C=require(${JSON.stringify(corePath)});process.stdout.write(C.weekKey('2026-08-24'));`,
  ], {
    encoding: "utf8",
    env: { ...process.env, TZ: "America/New_York" },
  });
  assert.equal(output, "2026-08-24");
});

run("a newer record owns an overlapping middle interval", () => {
  const old = entry("old", "2026-08-31", "09:00", "12:00", "work");
  const newer = entry("new", "2026-08-31", "10:00", "11:00", "study");
  const result = Core.upsertEntry([old], newer);
  assert.equal(result.trimmedMinutes, 60);
  assert.equal(result.entries.length, 3);
  assert.deepEqual(result.entries.map((item) => item.categoryId), ["work", "study", "work"]);
  assert.equal(minutes(result.entries), 180);
});

run("a newer record can fully replace an old record", () => {
  const old = entry("old", "2026-08-31", "10:00", "11:00", "work");
  const newer = entry("new", "2026-08-31", "09:00", "12:00", "study");
  const result = Core.upsertEntry([old], newer);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].id, "new");
  assert.equal(result.trimmedMinutes, 60);
});

run("left and right overlap preserve the non-overlapping fragment", () => {
  const old = entry("old", "2026-08-31", "10:00", "12:00", "work");
  const left = Core.upsertEntry([old], entry("left", "2026-08-31", "09:00", "11:00", "study"));
  assert.equal(left.entries.length, 2);
  assert.equal(minutes(left.entries), 180);
  const right = Core.upsertEntry([old], entry("right", "2026-08-31", "11:00", "13:00", "study"));
  assert.equal(right.entries.length, 2);
  assert.equal(minutes(right.entries), 180);
});

run("a newer record can span multiple records while adjacent ranges remain intact", () => {
  const first = entry("first", "2026-08-31", "08:00", "10:00", "work");
  const second = entry("second", "2026-08-31", "10:00", "12:00", "sleep");
  const spanning = entry("spanning", "2026-08-31", "09:00", "11:00", "study");
  const result = Core.upsertEntry([first, second], spanning);
  assert.equal(result.trimmedMinutes, 120);
  assert.deepEqual(result.entries.map((item) => item.categoryId), ["work", "study", "sleep"]);
  assert.equal(minutes(result.entries), 240);

  const adjacent = Core.upsertEntry(
    [entry("adjacent-old", "2026-08-31", "08:00", "09:00", "work")],
    entry("adjacent-new", "2026-08-31", "09:00", "10:00", "study")
  );
  assert.equal(adjacent.trimmedMinutes, 0);
  assert.equal(adjacent.entries.length, 2);
  assert.equal(minutes(adjacent.entries), 120);
});

run("optimized normalization matches sequential new-record-wins behavior", () => {
  let seed = 168;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let scenario = 0; scenario < 120; scenario += 1) {
    const source = [];
    const count = 4 + Math.floor(random() * 20);
    for (let index = 0; index < count; index += 1) {
      const start = Math.floor(random() * 80) * 15;
      const duration = (1 + Math.floor(random() * 16)) * 15;
      const startDate = local("2026-08-31", "00:00");
      source.push({
        id: `random-${scenario}-${index}`,
        start: Core.addMinutes(startDate, start).toISOString(),
        end: Core.addMinutes(startDate, start + duration).toISOString(),
        categoryId: `category-${index % 4}`,
      });
    }
    const sorted = source.slice().sort(
      (a, b) => new Date(a.start) - new Date(b.start) || new Date(a.end) - new Date(b.end)
    );
    let sequential = [];
    sorted.forEach((item) => { sequential = Core.upsertEntry(sequential, item).entries; });
    const canonical = (items) => items.map((item) => [item.start, item.end, item.categoryId]);
    assert.deepEqual(canonical(Core.normalizeEntries(source)), canonical(sequential));
  }
});

run("normalization stays practical for a large personal history", () => {
  const start = local("2020-01-06", "00:00");
  const source = Array.from({ length: 5000 }, (_, index) => ({
    id: `bulk-${index}`,
    start: Core.addMinutes(start, index * 15).toISOString(),
    end: Core.addMinutes(start, index * 15 + 15).toISOString(),
    categoryId: index % 2 ? "work" : "sleep",
  }));
  const began = Date.now();
  const normalized = Core.normalizeEntries(source);
  assert.equal(normalized.length, source.length);
  assert.ok(Date.now() - began < 2000, "5000 records should normalize in under two seconds");
});

run("quarter grid matches per-slot category calculation", () => {
  const week = local("2026-08-31", "12:00");
  const source = [
    entry("a", "2026-08-31", "09:15", "10:45", "study"),
    entry("b", "2026-09-01", "18:00", "19:30", "exercise"),
    entry("c", "2026-09-03", "23:45", "01:15", "sleep"),
    entry("d", "2026-09-06", "23:45", "00:15", "work"),
  ];
  const grid = Core.quarterCategoryGrid(source, week);
  assert.equal(grid.length, 672);
  const weekStart = Core.startOfWeek(week);
  for (let index = 0; index < grid.length; index += 1) {
    const start = Core.addMinutes(weekStart, index * 15);
    const end = Core.addMinutes(start, 15);
    assert.equal(grid[index], Core.dominantCategoryForRange(source, start, end));
  }
});

run("a complete 672-quarter week grid renders without a quadratic scan", () => {
  const start = local("2026-08-31", "00:00");
  const source = Array.from({ length: 672 }, (_, index) => ({
    id: `quarter-${index}`,
    start: Core.addMinutes(start, index * 15).toISOString(),
    end: Core.addMinutes(start, index * 15 + 15).toISOString(),
    categoryId: `category-${index % 8}`,
  }));
  const began = Date.now();
  const grid = Core.quarterCategoryGrid(source, start);
  assert.equal(grid.length, 672);
  assert.ok(grid.every(Boolean));
  assert.ok(Date.now() - began < 1000, "672-quarter grid should finish in under one second");
});

run("cross-midnight records split correctly across days", () => {
  const cross = entry("night", "2026-08-31", "23:00", "01:00", "sleep");
  const stats = Core.weekStats([cross], local("2026-08-31", "12:00"), [
    { id: "sleep", sleep: true },
  ]);
  assert.equal(stats.trackedMinutes, 120);
  assert.equal(stats.dayMinutes[0], 60);
  assert.equal(stats.dayMinutes[1], 60);
});

run("week boundaries clip records without losing duration", () => {
  const before = entry("before", "2026-08-30", "23:30", "00:30", "sleep");
  const after = entry("after", "2026-09-06", "23:30", "00:30", "sleep");
  const stats = Core.weekStats([before, after], local("2026-08-31", "12:00"), [
    { id: "sleep", sleep: true },
  ]);
  assert.equal(stats.trackedMinutes, 60);
  assert.equal(stats.dayMinutes[0], 30);
  assert.equal(stats.dayMinutes[6], 30);
});

run("generic weekly groups aggregate the public categories", () => {
  const entries = [
    entry("work", "2026-08-31", "09:00", "11:00", "work"),
    entry("study", "2026-08-31", "11:00", "12:00", "study"),
    entry("commute", "2026-09-01", "09:00", "10:00", "commute"),
    entry("routine", "2026-09-01", "10:00", "12:00", "routine"),
    entry("rest", "2026-09-02", "13:00", "14:00", "rest"),
    entry("leisure", "2026-09-02", "14:00", "16:00", "leisure"),
    entry("social", "2026-09-02", "16:00", "17:00", "social"),
  ];
  const stats = Core.weekStats(entries, local("2026-08-31", "12:00"), []);
  assert.equal(stats.workStudyMinutes, 180);
  assert.equal(stats.lifeMinutes, 180);
  assert.equal(stats.restLeisureMinutes, 180);
  assert.equal(stats.trackedMinutes, 600);
  assert.equal(stats.untrackedMinutes, Core.WEEK_MINUTES - 600);
});

run("prototype-like category ids cannot corrupt core totals", () => {
  const strange = entry("safe", "2026-08-31", "09:00", "10:00", "__proto__");
  const stats = Core.weekStats([strange], local("2026-08-31", "12:00"), []);
  assert.equal(stats.totals.__proto__, 60);
  assert.equal(Core.dominantCategoryForRange(
    [strange],
    local("2026-08-31", "09:00"),
    local("2026-08-31", "10:00")
  ), "__proto__");
});

run("empty weeks return zeroed generic groups", () => {
  const stats = Core.weekStats([], local("2026-08-31", "12:00"), []);
  assert.equal(stats.workStudyMinutes, 0);
  assert.equal(stats.lifeMinutes, 0);
  assert.equal(stats.restLeisureMinutes, 0);
  assert.equal(stats.trackedMinutes, 0);
  assert.equal(stats.untrackedMinutes, Core.WEEK_MINUTES);
});
