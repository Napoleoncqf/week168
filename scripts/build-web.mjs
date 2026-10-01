// 把 Android WebView 前端打包成可安装的 PWA，输出到 dist-web/（用于 GitHub Pages）。
// 用法：node scripts/build-web.mjs [输出目录]
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "android/app/src/main/assets");
const web = join(root, "web");
const out = join(root, process.argv[2] || "dist-web");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const name of ["styles.css", "core.js", "app.js"]) cpSync(join(assets, name), join(out, name));
cpSync(join(web, "icons"), join(out, "icons"), { recursive: true });
cpSync(join(web, "manifest.webmanifest"), join(out, "manifest.webmanifest"));

let html = readFileSync(join(assets, "index.html"), "utf8");
const head = [
  '<link rel="manifest" href="manifest.webmanifest" />',
  '<link rel="icon" href="icons/icon.svg" type="image/svg+xml" />',
  '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png" />',
  '<meta name="apple-mobile-web-app-capable" content="yes" />',
  '<meta name="mobile-web-app-capable" content="yes" />',
  '<meta name="apple-mobile-web-app-title" content="Week168" />',
].join("\n    ");
const register = `<script>
      if ("serviceWorker" in navigator) {
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
console.log(`PWA 已生成：${relative(root, out)}（${files.length + 1} 个文件）`);
