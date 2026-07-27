/**
 * One-time deep scan: searches all of GitHub (no date window) across multiple
 * query angles, verifies each candidate org, and adds confirmed vendors to the
 * official skills directory.
 *
 * Run:
 *   GITHUB_TOKEN=... node scripts/deep_scan_vendors.mjs
 *
 * Verification funnel:
 *   1. GitHub Organization (not a user account)
 *   2. At least one SKILL.md / skill.md in the discovered repo (not a fork)
 *   3. Declared website is live and not a platform URL
 *   4. Domain recognised in The Companies API, or GitHub organization is verified
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const DATA_PATH =
  process.env.OFFICIAL_SKILLS_OUTPUT ||
  path.join(root, "docs", "data", "official-skills-universal.json");

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const COMPANIES_KEY = process.env.COMPANIES_API_KEY;

if (!GITHUB_TOKEN)  { console.error("GITHUB_TOKEN is required."); process.exit(1); }

const ghHeaders = {
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "Skillscout deep scan",
  Authorization: `Bearer ${GITHUB_TOKEN}`,
};

const PLATFORM_DOMAINS = new Set([
  "github.com", "github.io", "gitlab.com", "bitbucket.org",
  "linkedin.com", "twitter.com", "x.com", "facebook.com",
  "linktr.ee", "linktree.com", "bio.link",
  "medium.com", "substack.com", "dev.to", "hashnode.com",
  "blogspot.com", "wordpress.com", "notion.site", "notion.so",
  "carrd.co", "beehiiv.com", "ghost.io",
  "vercel.app", "netlify.app", "pages.dev",
]);
const PLATFORM_NAMES = new Set([
  "github", "gitlab", "linkedin", "twitter", "facebook", "meta",
  "linktree", "medium", "blogspot", "wordpress", "notion", "vercel",
  "netlify", "cloudflare", "google", "microsoft", "amazon",
]);

function normalize(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9._\/-]+/g, "-").replace(/^-+|-+$/g, "");
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isTemplateSkillFilePath(filePath) {
  return /(^|\/)templates?\/skill\/SKILL\.md$/i.test(filePath);
}
function normalizeWebsiteUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(raw)) return `https://${raw}`;
  return raw;
}
function getWebsiteHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}
function isPlatformWebsite(url) {
  const hostname = getWebsiteHost(url);
  if (!hostname) return false;
  const root = hostname.split(".").slice(-2).join(".");
  return PLATFORM_DOMAINS.has(hostname) || PLATFORM_DOMAINS.has(root);
}

// ── GitHub helpers ────────────────────────────────────────────────────────────

async function ghFetch(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: ghHeaders });
    } catch {
      await sleep(2000);
      continue;
    }
    if (res.status === 429 || res.status === 403) {
      const retry = Number(res.headers.get("retry-after") || 60);
      console.warn(`  Rate limited — waiting ${retry}s`);
      await sleep(retry * 1000);
      continue;
    }
    return res;
  }
  return null;
}

async function runSearch(label, baseUrl) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const res = await ghFetch(`${baseUrl}&per_page=100&page=${page}`);
    if (!res?.ok) { console.warn(`  ${label}: failed ${res?.status} on page ${page}`); break; }
    const data = await res.json();
    const items = data.items || [];
    all.push(...items);
    if (items.length < 100) break;
    await sleep(1200); // stay under secondary rate limit
  }
  console.log(`  ${label}: ${all.length} results`);
  return all;
}

async function fetchOrgProfile(login) {
  const res = await ghFetch(`https://api.github.com/orgs/${login}`);
  if (!res?.ok) return null;
  return res.json();
}

async function getSkillPaths(repoFullName) {
  const res = await ghFetch(
    `https://api.github.com/repos/${repoFullName}/git/trees/HEAD?recursive=1`
  );
  if (!res?.ok) return { paths: [], truncated: false };
  const data = await res.json();
  const SKILL_RE = /(?:^|\/)(skill\.md)$/i;
  const paths = [];
  for (const item of data.tree || []) {
    if (item.type !== "blob") continue;
    const m = item.path.match(SKILL_RE);
    if (!m) continue;
    if (isTemplateSkillFilePath(item.path)) continue;
    const suffix = "/" + m[1];
    paths.push(
      item.path === m[1]
        ? normalize(repoFullName.split("/")[1])
        : normalize(item.path.slice(0, -(suffix.length)))
    );
  }
  return { paths, truncated: Boolean(data.truncated) };
}

async function checkWebsiteLive(url) {
  if (!url?.startsWith("http")) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { method: "HEAD", signal: ctrl.signal, redirect: "follow" });
    clearTimeout(t);
    if (res.ok || [401, 403, 405].includes(res.status)) return true;
  } catch {
    // Try GET below.
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    const res = await fetch(url, { method: "GET", signal: ctrl.signal, redirect: "follow" });
    clearTimeout(t);
    return res.ok || [401, 403].includes(res.status);
  } catch {
    return false;
  }
}

async function lookupCompany(websiteUrl) {
  if (!COMPANIES_KEY) return null;
  if (!websiteUrl?.startsWith("http")) return null;
  try {
    const hostname = new URL(websiteUrl).hostname.replace(/^www\./, "");
    const root = hostname.split(".").slice(-2).join(".");
    if (PLATFORM_DOMAINS.has(hostname) || PLATFORM_DOMAINS.has(root)) return null;
    const res = await fetch(
      `https://api.thecompaniesapi.com/v1/companies/${encodeURIComponent(hostname)}?free=true`,
      { headers: { Authorization: `Bearer ${COMPANIES_KEY}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.name) return null;
    const nameLower = data.name.toLowerCase().replace(/[^a-z]/g, "");
    if (PLATFORM_NAMES.has(nameLower)) return null;
    return { name: data.name, industry: (data.industries || []).slice(0, 3).join(", ") };
  } catch { return null; }
}

async function fetchStars(repoFullName) {
  const res = await ghFetch(`https://api.github.com/repos/${repoFullName}`);
  if (!res?.ok) return 0;
  const data = await res.json();
  return data.stargazers_count ?? 0;
}

// ── Search GitHub ─────────────────────────────────────────────────────────────

console.log("Searching GitHub (no date window — full historical scan)...");
const c1 = await runSearch(
  'SKILL.md + "skills install"',
  `https://api.github.com/search/code?q=${encodeURIComponent('filename:SKILL.md "skills install"')}&sort=indexed`
);
const c2 = await runSearch(
  'SKILL.md + "skills add"',
  `https://api.github.com/search/code?q=${encodeURIComponent('filename:SKILL.md "skills add"')}&sort=indexed`
);
const c3 = await runSearch(
  "lowercase skill.md",
  `https://api.github.com/search/code?q=${encodeURIComponent("filename:skill.md")}&sort=indexed`
);
const r1 = await runSearch(
  "topic:agent-skills",
  `https://api.github.com/search/repositories?q=${encodeURIComponent("topic:agent-skills")}&sort=updated`
);
const r2 = await runSearch(
  "topic:claude-skills",
  `https://api.github.com/search/repositories?q=${encodeURIComponent("topic:claude-skills")}&sort=updated`
);

// ── Dedupe candidates ─────────────────────────────────────────────────────────

const directory = JSON.parse(await fs.readFile(DATA_PATH, "utf8"));
const knownKeys = new Set(directory.officialOwners.map(o => o.ownerKey));

const seen = new Set();
const candidates = [];
for (const item of [
  ...c1, ...c2, ...c3,
  ...r1.map(r => ({ repository: r })),
  ...r2.map(r => ({ repository: r })),
]) {
  const full = item.repository?.full_name;
  if (!full) continue;
  if (item.repository?.fork) continue;
  const login = full.split("/")[0];
  const ownerKey = normalize(login);
  if (seen.has(ownerKey) || knownKeys.has(ownerKey)) continue;
  seen.add(ownerKey);
  candidates.push({ login, ownerKey, repoFullName: full });
}

console.log(`\n${candidates.length} unknown candidate orgs to verify\n`);

// ── Verification pipeline ─────────────────────────────────────────────────────

const now = new Date().toISOString();
let addedOwners = 0;
let checked = 0;

for (const info of candidates) {
  checked++;
  if (checked % 100 === 0) {
    console.log(`\n[${checked}/${candidates.length}] — ${addedOwners} confirmed so far\n`);
  }

  if (knownKeys.has(info.ownerKey)) continue;

  const profile = await fetchOrgProfile(info.login);
  if (!profile || profile.type !== "Organization") continue;

  const website = normalizeWebsiteUrl(profile.blog || "");
  if (isPlatformWebsite(website)) continue;
  const company = await lookupCompany(website);
  const verifiedByGitHub = profile.is_verified === true;
  if (!company && !verifiedByGitHub) continue;
  if (!(await checkWebsiteLive(website))) continue;

  const { paths: skillPaths, truncated } = await getSkillPaths(info.repoFullName);
  if (skillPaths.length === 0) continue;

  const stars = await fetchStars(info.repoFullName);
  const displayName = company?.name || profile.name || info.login;
  console.log(`  ✅ ${info.ownerKey} → ${displayName}  (${company?.industry || "GitHub verified"})  skills:${skillPaths.length}  ⭐${stars}`);

  const repoKey = info.repoFullName.toLowerCase();

  directory.officialOwners.push({
    ownerKey: info.ownerKey,
    displayName,
    normalizedNames: [info.ownerKey],
    sourceOwnerKeys: [info.login],
    websiteHosts: [],
    website,
    sources: ["github-discovery"],
    sourceUrls: [`https://github.com/${info.login}`],
    skillsCount: skillPaths.length,
    reposCount: 1,
    installsCount: 0,
    starsCount: stars,
    confidence: "high",
    dbConfirmed: Boolean(company),
    githubVerified: verifiedByGitHub,
    companyIndustry: company?.industry || "",
    firstSeenAt: now,
    lastSeenAt: now,
    ...(profile.twitter_username ? { twitter: `@${profile.twitter_username}` } : {}),
  });

  directory.officialRepos.push({
    repoKey,
    ownerKey: info.ownerKey,
    sourceOwnerKeys: [info.login],
    repoName: info.repoFullName.split("/")[1],
    displayName: info.repoFullName,
    sources: ["github-discovery"],
    sourceUrls: [`https://github.com/${info.repoFullName}`],
    skillsCount: skillPaths.length,
    installsCount: 0,
    starsCount: stars,
    confidence: "high",
    firstSeenAt: now,
    lastSeenAt: now,
    githubSkillPaths: skillPaths,
    truncated,
  });

  for (const skillPath of skillPaths) {
    directory.officialSkills.push({
      skillKey: `${repoKey}/${skillPath}`,
      ownerKey: info.ownerKey,
      sourceOwnerKeys: [info.login],
      repoKey,
      skillName: skillPath.split("/").pop(),
      displayName: skillPath.split("/").pop(),
      description: "",
      sources: ["github"],
      sourceUrls: [`https://github.com/${info.repoFullName}/tree/HEAD/${skillPath}`],
      installsCount: 0,
      confidence: "high",
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }

  knownKeys.add(info.ownerKey);
  addedOwners++;

  // Persist after each confirmed vendor so progress survives interruptions
  directory.stats.owners = directory.officialOwners.length;
  directory.stats.repos  = directory.officialRepos.length;
  directory.stats.skills = directory.officialSkills.length;
  directory.generatedAt  = now;
  await fs.writeFile(DATA_PATH, JSON.stringify(directory, null, 2) + "\n");
}

// Final sort
directory.officialOwners.sort((a, b) => a.ownerKey.localeCompare(b.ownerKey));
directory.officialRepos.sort((a, b)  => a.repoKey.localeCompare(b.repoKey));
directory.officialSkills.sort((a, b) => a.skillKey.localeCompare(b.skillKey));
directory.stats.owners = directory.officialOwners.length;
directory.stats.repos  = directory.officialRepos.length;
directory.stats.skills = directory.officialSkills.length;
directory.generatedAt  = now;
await fs.writeFile(DATA_PATH, JSON.stringify(directory, null, 2) + "\n");

console.log(`\n✅ Deep scan complete.`);
console.log(`Added ${addedOwners} new vendors.`);
console.log(`Directory: ${directory.stats.owners} owners, ${directory.stats.repos} repos, ${directory.stats.skills} skills`);
