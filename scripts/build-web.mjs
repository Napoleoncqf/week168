// 把 WebView 前端打包成可安装的 PWA（默认通用版），输出到 dist-web/（用于 GitHub Pages）。
// 用法：node scripts/build-web.mjs [输出目录] [--edition general]
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Edition = require("./edition.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(root, "web");
const args = process.argv.slice(2);
const editionFlag = args.indexOf("--edition");
const editionId = editionFlag >= 0 ? args.splice(editionFlag, 2)[1] : "general";
const out = join(root, args[0] || "dist-web");
const edition = Edition.loadEdition(editionId);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
Edition.stageAssets(edition, out);
Edition.copyTree(join(web, "icons"), join(out, "icons"));
copyFileSync(join(web, "manifest.webmanifest"), join(out, "manifest.webmanifest"));

let html = readFileSync(join(out, "index.html"), "utf8");
const head = [
  '<link rel="manifest" href="manifest.webmanifest" />',
  '<link rel="icon" href="icons/icon.svg" type="image/svg+xml" />',
  '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png" />',
  '<meta name="apple-mobile-web-app-capable" content="yes" />',
  '<meta name="mobile-web-app-capable" content="yes" />',
  `<meta name="apple-mobile-web-app-title" content="${edition.appName}" />`,
].join("\n    ");
// 新版本的 service worker 接管后自动刷新一次，避免更新后第一次打开仍是旧缓存。
// 首次安装（此前没有 controller）不刷新。
const register = `<script>
      if ("serviceWorker" in navigator) {
        const hadController = Boolean(navigator.serviceWorker.controller);
        let reloaded = false;
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          if (!hadController || reloaded) return;
          reloaded = true;
          window.location.reload();
        });
        window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
      }
    </script>`;
if (!html.includes("</head>") || !html.includes("</body>")) throw new Error("index.html 结构异常");
html = html.replace("</head>", `    ${head}\n  </head>`).replace("</body>", `  ${register}\n  </body>`);
writeFileSync(join(out, "index.html"), html);
writeFileSync(join(out, ".nojekyll"), "");

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (!name.startsWith(".")) files.push(relative(out, full).split("\\").join("/"));
  }
})(out);
files.sort();
const hash = createHash("sha256");
for (const file of files) hash.update(file).update(readFileSync(join(out, file)));
const precache = ["./", ...files.map((file) => `./${file}`)];
const sw = readFileSync(join(web, "sw.js"), "utf8")
  .replace("__BUILD_HASH__", hash.digest("hex").slice(0, 12))
  .replace("__PRECACHE__", JSON.stringify(precache));
writeFileSync(join(out, "sw.js"), sw);
console.log(`PWA 已生成（${editionId}）：${relative(root, out)}（${files.length + 1} 个文件）`);
