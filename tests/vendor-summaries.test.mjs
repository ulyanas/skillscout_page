import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import test from "node:test";

import { VENDOR_SUMMARIES } from "../docs/lib/vendor-summaries.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const escapeHtml = (text) => text.replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

test("reviewed descriptions have one sentence and traceable sources", () => {
  assert.ok(Object.keys(VENDOR_SUMMARIES).length >= 100);
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  for (const [ownerKey, entry] of Object.entries(VENDOR_SUMMARIES)) {
    assert.equal([...segmenter.segment(entry.summary)].length, 1, ownerKey);
    assert.ok(entry.summary.endsWith("."), ownerKey);
    assert.doesNotMatch(entry.summary, /publishes official AI agent skills|[\r\n<>]/, ownerKey);
    assert.ok(entry.sources.length > 0, ownerKey);
    for (const source of entry.sources) {
      assert.ok(["http:", "https:"].includes(new URL(source).protocol), ownerKey);
    }
    assert.match(entry.reviewedAt, /^\d{4}-\d{2}-\d{2}$/, ownerKey);
  }
});

test("current and archived pages keep reviewed summaries between the introduction and skill counts", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "vendor-summaries-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const current = JSON.parse(await fs.readFile(path.join(root, "docs/data/official-skills-universal.json"), "utf8"));
  const archive = JSON.parse(gunzipSync(await fs.readFile(path.join(root, "scripts/data/archived-official-skills.json.gz"))));
  const selected = new Set(Object.keys(VENDOR_SUMMARIES));
  const filter = (data) => Object.fromEntries(
    ["officialOwners", "officialRepos", "officialSkills"].map((key) => [
      key, data[key].filter((entry) => selected.has(entry.ownerKey))
    ])
  );
  const data = filter(current);
  // Simulate a catalog refresh replacing descriptions with generic profile text.
  data.officialOwners = data.officialOwners.map((owner) => ({ ...owner, description: "Tools for developers" }));
  const frozen = filter(archive);
  const archivedPages = JSON.parse(await fs.readFile(path.join(root, "docs/data/archived-official-pages.json"), "utf8"));
  await fs.writeFile(path.join(temporary, "data.json"), JSON.stringify(data));
  await fs.writeFile(path.join(temporary, "archive.gz"), gzipSync(JSON.stringify(frozen)));
  await fs.writeFile(path.join(temporary, "pages.json"), JSON.stringify({ pages: archivedPages.pages.filter((page) => selected.has(page.ownerKey)) }));
  execFileSync(process.execPath, [
    path.join(root, "scripts/generate-vendor-pages.mjs"),
    "--data", path.join(temporary, "data.json"),
    "--archived-skills", path.join(temporary, "archive.gz"),
    "--archived-pages", path.join(temporary, "pages.json"),
    "--site-root", path.join(temporary, "site")
  ], { cwd: root, stdio: "pipe" });

  let archivedCount = 0;
  for (const [ownerKey, { summary }] of Object.entries(VENDOR_SUMMARIES)) {
    const html = await fs.readFile(path.join(temporary, "site/official", ownerKey, "index.html"), "utf8");
    const descriptions = [...html.matchAll(/<p class="vendor-description">(.*?)<\/p>/gs)].map((match) => match[1]);
    assert.equal(descriptions.length, 2, ownerKey);
    assert.ok(descriptions[0].endsWith(`developer workflows. ${escapeHtml(summary)}`), ownerKey);
    assert.match(descriptions[1], /^Browse \d/, ownerKey);
    assert.equal(descriptions[0].split(escapeHtml(summary)).length, 2, ownerKey);
    assert.doesNotMatch(html, /name="robots" content="noindex/, ownerKey);
    const markdown = await fs.readFile(path.join(temporary, "site/official", ownerKey, `${ownerKey}_skills_skillscout.md`), "utf8");
    assert.ok(markdown.includes(summary), ownerKey);
    if (!data.officialOwners.some((owner) => owner.ownerKey === ownerKey)) archivedCount++;
  }
  assert.ok(archivedCount > 0, "The audit includes archived vendor pages");
});
