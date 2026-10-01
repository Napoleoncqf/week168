"use strict";

const assert = require("node:assert/strict");
const Import = require("../android/app/src/main/assets/text-import.js");

const categories = [{ id: "work" }, { id: "routine" }];
const farFuture = new Date(2026, 9, 1);

function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

check("JSON response keeps clear spans and unresolved text separate", () => {
  const parsed = Import.parseResponse('```json\n{"items":[{"start":"09:00","end":"12:00","categoryId":"work","content":"项目会议","inferred":true}],"unresolved":[{"text":"下午读书","reason":"没有结束时间"}]}\n```');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.drafts.length, 1);
  assert.equal(parsed.drafts[0].start, "09:00");
  assert.equal(parsed.drafts[0].inferred, true);
  assert.equal(parsed.unresolved[0].text, "下午读书");
});

check("valid drafts never overwrite an existing interval", () => {
  const drafts = [
    { selected: true, start: "09:00", end: "12:00", categoryId: "work", content: "工作" },
    { selected: true, start: "12:00", end: "13:00", categoryId: "routine", content: "午饭" },
  ];
  const clean = Import.validateDrafts("2026-09-01", drafts, categories, [], farFuture);
  assert.equal(clean.errors.length, 0);
  assert.equal(clean.candidates.length, 2);
  const conflict = Import.validateDrafts("2026-09-01", drafts, categories,
    [{ start: clean.candidates[0].start, end: clean.candidates[0].end }], farFuture);
  assert.equal(conflict.errors.length, 1);
  assert.match(conflict.errors[0].message, /重叠/);
  assert.equal(conflict.candidates.length, 1);
});

check("cross-midnight and 24:00 are valid when unambiguous", () => {
  const drafts = [{ selected: true, start: "23:00", end: "24:00", categoryId: "work", content: "值班" }];
  const checked = Import.validateDrafts("2026-09-01", drafts, categories, [], farFuture);
  assert.equal(checked.errors.length, 0);
  assert.equal(new Date(checked.candidates[0].end).getTime() - new Date(checked.candidates[0].start).getTime(), 60 * 60 * 1000);
});

check("unclear times, unknown categories and future spans require correction", () => {
  const invalid = [
    { selected: true, start: "09:10", end: "10:00", categoryId: "work", content: "" },
    { selected: true, start: "10:00", end: "11:00", categoryId: "unknown", content: "" },
  ];
  assert.equal(Import.validateDrafts("2026-09-01", invalid, categories, [], farFuture).errors.length, 2);
  const future = [{ selected: true, start: "20:00", end: "21:00", categoryId: "work", content: "计划" }];
  const now = new Date(2026, 8, 1, 12, 0);
  assert.match(Import.validateDrafts("2026-09-01", future, categories, [], now).errors[0].message, /尚未发生/);
});


check("a reply cut off at the output limit asks to split the day", () => {
  const truncated = Import.parseResponse('{"items":[{"start":"09:00","end":"10:00","categoryId":"work"');
  assert.equal(truncated.ok, false);
  assert.match(truncated.message, /截断/);
  assert.doesNotMatch(Import.parseResponse("not json").message, /截断/);
});
