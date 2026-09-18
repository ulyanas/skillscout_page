import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyVendorIndexPolicy, isVendorUrl, validateIndexPolicy } from "../scripts/vendor-indexing.mjs";

const origin = "https://skillscout.sh";
const policy = () => ({
  version: 1, site: "sc-domain:skillscout.sh", source: "search-console-api",
  searchType: "web", dataState: "final",
  pages: Array.from({ length: 200 }, (_, i) => ({ url: `${origin}/official/vendor-${i}/`, clicks: 200 - i, impressions: 1000 }))
});

test("selection is restricted to 200 distinct vendor URLs", () => {
  assert.equal(isVendorUrl(`${origin}/guides/lovable/`), false);
  assert.equal(isVendorUrl(`${origin}/official/`), false);
  assert.equal(isVendorUrl(`${origin}/official/vendor/page/2/`), true);
  assert.equal(isVendorUrl(`${origin}/official/vendor/skill.md`), false);
  assert.equal(isVendorUrl("https://other.example/official/vendor/"), false);
  assert.throws(() => validateIndexPolicy({ ...policy(), pages: [] }));
  const invalid = policy();
  invalid.pages[199] = invalid.pages[0];
  assert.throws(() => validateIndexPolicy(invalid));
  invalid.pages[199] = { url: `${origin}/guides/`, clicks: 1, impressions: 1 };
  assert.throws(() => validateIndexPolicy(invalid));
});

test("build keeps exactly selected vendor pages and preserves other sections", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vendor-indexing-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = policy();
  const excluded = [`${origin}/official/extra/`, `${origin}/official/vendor-0/page/2/`];
  const vendorUrls = [...config.pages.map((p) => p.url), ...excluded];
  const unchanged = ["index.html", "official/index.html", "guides/index.html", "guides/lovable/index.html", "about/index.html", "robots.txt"];
  const html = (url) => `<html><head><meta name="robots" content="index, follow" /><link rel="canonical" href="${url}" /></head><body id="vendorTitle">Content</body></html>`;
  for (const url of vendorUrls) {
    const file = path.join(root, new URL(url).pathname, "index.html");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, html(url));
  }
  for (const relative of unchanged) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "Preserve this file exactly");
  }
  const sitemap = `<urlset>${[...vendorUrls, `${origin}/guides/lovable/`, `${origin}/official/`].map((url) => `<url><loc>${url}</loc><lastmod>2026-09-01</lastmod></url>`).join("")}</urlset>`;
  for (const name of ["sitemap.xml", "sitemap-vendors.xml", "sitemap-core.xml"]) await fs.writeFile(path.join(root, name), sitemap);
  const configPath = path.join(root, "policy.json");
  await fs.writeFile(configPath, JSON.stringify(config));
  assert.deepEqual(await applyVendorIndexPolicy(root, configPath), { indexed: 200, noindex: 2, total: 202 });
  for (const url of vendorUrls) {
    const result = await fs.readFile(path.join(root, new URL(url).pathname, "index.html"), "utf8");
    assert.equal(result, excluded.includes(url) ? html(url).replace('content="index, follow"', 'content="noindex, follow"') : html(url));
  }
  for (const relative of unchanged) assert.equal(await fs.readFile(path.join(root, relative), "utf8"), "Preserve this file exactly");
  const xml = await fs.readFile(path.join(root, "sitemap.xml"), "utf8");
  for (const url of excluded) assert.ok(!xml.includes(`<loc>${url}</loc>`));
  assert.ok(xml.includes(`<loc>${origin}/guides/lovable/</loc><lastmod>2026-09-01</lastmod>`));
  assert.ok(xml.includes(`<loc>${origin}/official/</loc>`));
  assert.deepEqual(await applyVendorIndexPolicy(root, configPath), { indexed: 200, noindex: 2, total: 202 });
  await fs.rm(path.join(root, "official/vendor-0/index.html"));
  await assert.rejects(applyVendorIndexPolicy(root, configPath), /missing or has moved/);
});

test("absent policy preserves the existing build", async () => {
  assert.equal(await applyVendorIndexPolicy("/unused", new URL("./missing-vendor-index-policy.json", import.meta.url)), null);
});
