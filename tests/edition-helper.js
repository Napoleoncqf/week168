"use strict";
// 测试统一从 editions/*.json 生成前端版本配置；公开仓库只有通用版，个人版用例会自动跳过。

const vm = require("node:vm");
const Edition = require("../scripts/edition.js");

const EDITIONS = Edition.listEditions();
const PRIMARY_EDITION = EDITIONS.includes("personal") ? "personal" : "general";

function hasEdition(id) {
  return EDITIONS.includes(id);
}

// Runs the generated edition.js inside a vm context before app.js.
function installEdition(context, id) {
  vm.runInNewContext(Edition.editionScript(Edition.loadEdition(id)), context, { filename: "edition.js" });
  return context.Time168Edition;
}

module.exports = { Edition, EDITIONS, PRIMARY_EDITION, hasEdition, installEdition };
