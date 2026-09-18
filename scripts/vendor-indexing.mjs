import fs from "node:fs/promises";
import path from "node:path";

const ORIGIN = "https://skillscout.sh";
const VENDOR_PATH = /^\/official\/[a-z0-9][a-z0-9._-]*\/(?:page\/[1-9][0-9]*\/)?$/i;

export function isVendorUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === ORIGIN && !url.search && !url.hash && VENDOR_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

export function validateIndexPolicy(policy) {
  if (policy.version !== 1 || policy.site !== "sc-domain:skillscout.sh" ||
      policy.source !== "search-console-api" || policy.searchType !== "web" ||
      policy.dataState !== "final" || !Array.isArray(policy.pages) || policy.pages.length !== 200) {
    throw new Error("Vendor indexing policy requires 200 URLs from finalized Search Console API data");
  }
  const urls = new Set(policy.pages.map((page) => page.url));
  if (urls.size !== 200 || [...urls].some((url) => !isVendorUrl(url))) {
    throw new Error("Vendor indexing policy contains duplicate or out-of-scope URLs");
  }
  for (const page of policy.pages) {
    if (!Number.isFinite(page.clicks) || page.clicks < 0 ||
        !Number.isFinite(page.impressions) || page.impressions <= 0) {
      throw new Error("Vendor indexing policy requires valid traffic metrics for each URL");
    }
  }
  return urls;
}

export async function applyVendorIndexPolicy(siteRoot, policyFile) {
  let policy;
  try {
    policy = JSON.parse(await fs.readFile(policyFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const allowed = validateIndexPolicy(policy);
  const pages = new Map();
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.name === "index.html") {
        const relative = path.relative(siteRoot, path.dirname(file)).split(path.sep).join("/");
        const url = `${ORIGIN}/${relative}/`;
        if (isVendorUrl(url)) pages.set(url, { file, html: await fs.readFile(file, "utf8") });
      }
    }
  }
  await visit(path.join(siteRoot, "official"));

  // Validate the complete selection before changing any output file.
  for (const url of allowed) {
    const page = pages.get(url);
    if (!page || !page.html.includes('id="vendorTitle"') ||
        !page.html.includes(`<link rel="canonical" href="${url}"`)) {
      throw new Error(`Selected vendor URL is missing or has moved: ${url}`);
    }
  }
  const updates = [];
  for (const [url, page] of pages) {
    const tags = page.html.match(/<meta\s+name="robots"\s+content="[^"]*"\s*\/?\s*>/gi) || [];
    if (tags.length !== 1) throw new Error(`Expected exactly one robots directive: ${url}`);
    const directive = allowed.has(url) ? "index, follow" : "noindex, follow";
    updates.push({ file: page.file, html: page.html.replace(tags[0], `<meta name="robots" content="${directive}" />`) });
  }
  for (const name of ["sitemap.xml", "sitemap-vendors.xml", "sitemap-core.xml"]) {
    const file = path.join(siteRoot, name);
    const xml = await fs.readFile(file, "utf8");
    const html = xml.replace(/\s*<url>\s*<loc>([^<]+)<\/loc>[\s\S]*?<\/url>/g, (entry, url) =>
      isVendorUrl(url) && !allowed.has(url) ? "" : entry);
    updates.push({ file, html });
  }
  for (const update of updates) await fs.writeFile(update.file, update.html, "utf8");
  return { indexed: allowed.size, noindex: pages.size - allowed.size, total: pages.size };
}
