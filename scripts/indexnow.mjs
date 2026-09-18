import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const ORIGIN = "https://skillscout.sh";
export const KEY = "1d32fd44a6874306abd91c8ae5b80efb";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, ".pages-dist");
const MANIFEST = "indexnow-manifest.json";
const QUEUE = path.join(ROOT, ".indexnow-urls.json");

export function validateUrls(urls) {
  if (!Array.isArray(urls)) throw new Error("Expected an array of URLs");
  return [...new Set(urls.map((value) => {
    const url = new URL(value);
    if (url.origin !== ORIGIN || url.username || url.password || url.hash || url.search) {
      throw new Error(`Expected a canonical ${ORIGIN} URL: ${value}`);
    }
    return url.href;
  }))];
}

export function changedUrls(previous, current) {
  return validateUrls([...new Set([...Object.keys(previous), ...Object.keys(current)])])
    .filter((url) => previous[url] !== current[url]);
}

async function request(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
}

export async function createManifest(siteRoot) {
  const xml = await fs.readFile(path.join(siteRoot, "sitemap.xml"), "utf8");
  const urls = validateUrls([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) =>
    match[1].trim().replaceAll("&amp;", "&")
  ));
  if (!urls.length) throw new Error("Expected pages in sitemap.xml");
  const pages = {};
  for (const url of urls.sort()) {
    const pathname = decodeURIComponent(new URL(url).pathname);
    const relative = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
    const filename = path.resolve(siteRoot, `.${relative}`);
    if (!filename.startsWith(`${path.resolve(siteRoot)}${path.sep}`)) {
      throw new Error(`Page path must be inside the site: ${url}`);
    }
    const html = await fs.readFile(filename);
    pages[url] = createHash("sha256").update(html).digest("hex");
  }
  return pages;
}

async function prepare() {
  const current = await createManifest(SITE);
  const response = await request(`${ORIGIN}/${MANIFEST}?run=${Date.now()}`);
  let urls;
  if (response.status === 404) {
    // Establish the baseline and verify the integration with the homepage.
    urls = [`${ORIGIN}/`];
    console.log("Establishing IndexNow baseline; submitting the homepage.");
  } else {
    if (!response.ok) throw new Error(`Previous manifest returned HTTP ${response.status}`);
    const previous = await response.json();
    if (previous.version !== 1 || !previous.pages || typeof previous.pages !== "object" || Array.isArray(previous.pages)) {
      throw new Error("Expected an IndexNow manifest with version 1 and page hashes");
    }
    urls = changedUrls(previous.pages, current);
  }
  await fs.writeFile(path.join(SITE, MANIFEST), `${JSON.stringify({ version: 1, pages: current })}\n`);
  await fs.writeFile(QUEUE, `${JSON.stringify(urls, null, 2)}\n`);
  console.log(`Prepared ${urls.length} IndexNow URLs.`);
}

export async function submit(urls, fetcher = request) {
  urls = validateUrls(urls);
  if (!urls.length) {
    console.log("IndexNow: published pages are unchanged.");
    return;
  }
  const keyLocation = `${ORIGIN}/${KEY}.txt`;
  const verification = await fetcher(keyLocation);
  if (verification.status !== 200 || (await verification.text()).trim() !== KEY) {
    throw new Error(`Publish the matching key at ${keyLocation} before submitting URLs`);
  }
  for (let offset = 0; offset < urls.length; offset += 10_000) {
    const batch = urls.slice(offset, offset + 10_000);
    const response = await fetcher("https://www.bing.com/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host: new URL(ORIGIN).host, key: KEY, keyLocation, urlList: batch })
    });
    if (response.status !== 200 && response.status !== 202) {
      throw new Error(`IndexNow HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    console.log(`IndexNow: ${batch.length} URLs received (HTTP ${response.status})${response.status === 202 ? "; key validation pending" : ""}.`);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "prepare") return prepare();
  if (command === "submit") {
    return submit(args.length ? args : JSON.parse(await fs.readFile(QUEUE, "utf8")));
  }
  if (command === "submit-file" && args.length === 1) {
    return submit(JSON.parse(await fs.readFile(args[0], "utf8")));
  }
  throw new Error("Usage: node scripts/indexnow.mjs prepare | submit [URL ...] | submit-file FILE");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
