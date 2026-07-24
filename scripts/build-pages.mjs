import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const DOCS_DIR = path.join(ROOT_DIR, "docs");
const SITE_DIR = path.resolve(
  process.env.PAGES_OUTPUT_DIR || path.join(ROOT_DIR, ".pages-dist")
);
const OFFICIAL_ROOT_FILES = new Set([
  "index.html",
  "vendor-page.css",
  "vendor-page.js"
]);

await fs.rm(SITE_DIR, { recursive: true, force: true });
await fs.cp(DOCS_DIR, SITE_DIR, {
  recursive: true,
  filter(source) {
    const relative = path.relative(DOCS_DIR, source);
    if (!relative) return true;

    const parts = relative.split(path.sep);
    if (parts[0] !== "official" || parts.length < 2) {
      return true;
    }
    return parts.length === 2 && OFFICIAL_ROOT_FILES.has(parts[1]);
  }
});

await fs.writeFile(path.join(SITE_DIR, ".nojekyll"), "", "utf8");
await runNode([
  path.join(SCRIPT_DIR, "generate-vendor-pages.mjs"),
  "--site-root",
  SITE_DIR
]);

const stats = await getDirectoryStats(SITE_DIR);
console.log(
  `Pages artifact ready: ${stats.files.toLocaleString("en-US")} files, ${formatBytes(stats.bytes)}`
);

async function runNode(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed with exit code ${code}`));
    });
  });
}

async function getDirectoryStats(directory) {
  let files = 0;
  let bytes = 0;
  const entries = await fs.readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const child = await getDirectoryStats(entryPath);
      files += child.files;
      bytes += child.bytes;
      continue;
    }
    if (entry.isFile()) {
      const stat = await fs.stat(entryPath);
      files += 1;
      bytes += stat.size;
    }
  }

  return { files, bytes };
}

function formatBytes(value) {
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${amount.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}
