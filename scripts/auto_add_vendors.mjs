/**
 * Discovers new official skill vendors from GitHub and auto-adds them
 * to the official skills directory after verifying with The Companies API.
 *
 * A candidate org qualifies when:
 *   1. It is a GitHub Organization (not an individual user account)
 *   2. The skill repo is owned by the org directly (not a fork)
 *   3. The org's declared website (profile.blog) is a live, non-platform URL
 *   4. That domain is recognised in The Companies API
 *
 * Run:
 *   GITHUB_TOKEN=$(gh auth token) \
 *   COMPANIES_API_KEY=<key> \
 *   node scripts/auto_add_vendors.mjs
 *
 * Env vars:
 *   GITHUB_TOKEN          required — GitHub API access
 *   COMPANIES_API_KEY     required — The Companies API (thecompaniesapi.com)
 *   OFFICIAL_SKILLS_OUTPUT  optional — path to JSON (default: docs/data/official-skills-universal.json)
 *   DISCOVERY_WINDOW_DAYS   optional — days back to search (default: 14)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const DATA_PATH =
  process.env.OFFICIAL_SKILLS_OUTPUT ||
  path.join(root, "docs", "data", "official-skills-universal.json");

const GITHUB_TOKEN    = process.env.GITHUB_TOKEN;
const COMPANIES_KEY   = process.env.COMPANIES_API_KEY;
const WINDOW_DAYS     = Number(process.env.DISCOVERY_WINDOW_DAYS || 14);

if (!GITHUB_TOKEN) {
  console.error("GITHUB_TOKEN is required.");
  process.exit(1);
}
if (!COMPANIES_KEY) {
  console.error("COMPANIES_API_KEY is required.");
  process.exit(1);
}

const ghHeaders = {
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "Skillscout vendor discovery",
  Authorization: `Bearer ${GITHUB_TOKEN}`,
};

const now = new Date().toISOString();

// ── Load directory ────────────────────────────────────────────────────────────

const directory = JSON.parse(await fs.readFile(DATA_PATH, "utf8"));
const knownOwnerKeys = new Set(directory.officialOwners.map((o) => o.ownerKey));
const knownRepoKeys  = new Set(directory.officialRepos.map((r) => r.repoKey));

console.log(`Loaded ${knownOwnerKeys.size} owners, ${knownRepoKeys.size} repos from ${DATA_PATH}`);

// ── GitHub search ─────────────────────────────────────────────────────────────

const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);

async function runSearch(label, url) {
  const res = await fetch(url, { headers: ghHeaders });
  if (!res.ok) {
    console.warn(`  Search failed (${res.status}): ${label}`);
    return [];
  }
  const data = await res.json();
  console.log(`  ${label}: ${data.total_count ?? 0} total, got ${data.items?.length ?? 0}`);
  return data.items ?? [];
}

console.log("\nSearching GitHub...");
const [codeItems, repoItems] = await Promise.all([
  runSearch(
    'SKILL.md containing "skills install"',
    `https://api.github.com/search/code?q=${encodeURIComponent('filename:SKILL.md "skills install"')}&per_page=100&sort=indexed`
  ),
  runSearch(
    `topic:agent-skills pushed since ${since}`,
    `https://api.github.com/search/repositories?q=${encodeURIComponent(`topic:agent-skills pushed:>${since}`)}&per_page=100&sort=updated`
  ),
]);

const normalizedRepoItems = repoItems.map((repo) => ({
  repository: repo,
  path: "SKILL.md",
  html_url: `${repo.html_url}/blob/HEAD/SKILL.md`,
}));

const allItems = [...codeItems, ...normalizedRepoItems];

// ── Collect unique unknown orgs ───────────────────────────────────────────────

function normalizeLogin(login) {
  return String(login || "").toLowerCase().replace(/[^a-z0-9._/-]+/g, "-").replace(/^-+|-+$/g, "");
}

const candidates = new Map(); // ownerKey → info

for (const item of allItems) {
  const fullName = item.repository?.full_name;
  if (!fullName) continue;

  // Skip forks — a forked repo isn't the org's own skill, it's borrowed
  if (item.repository?.fork) continue;

  const [login] = fullName.split("/");
  const ownerKey = normalizeLogin(login);
  if (knownOwnerKeys.has(ownerKey)) continue; // already tracked
  if (!candidates.has(ownerKey)) {
    candidates.set(ownerKey, {
      login,
      ownerKey,
      repoKey: fullName.toLowerCase(),
      repoFullName: fullName,
      skillFile: item.path,
      repoHtmlUrl: item.repository?.html_url,
    });
  }
}

console.log(`\n${candidates.size} unknown orgs found in search results`);

// ── Fetch GitHub org profiles ─────────────────────────────────────────────────

async function fetchOrgProfile(login) {
  // Only fetch the org endpoint — we reject non-Organization accounts anyway
  // and the users/ endpoint can return a personal account with the same login.
  const res = await fetch(`https://api.github.com/orgs/${login}`, { headers: ghHeaders });
  if (!res.ok) return null;
  return res.json();
}

async function checkWebsiteLive(url) {
  if (!url?.startsWith("http")) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { method: "HEAD", signal: ctrl.signal, redirect: "follow" });
    clearTimeout(t);
    return res.ok || res.status === 405;
  } catch {
    return false;
  }
}

// Platforms that people use as their "website" but aren't the company's own domain.
// A Companies API hit on these means the website URL points to a platform, not the vendor.
const PLATFORM_DOMAINS = new Set([
  "github.com", "github.io", "gitlab.com", "bitbucket.org",
  "linkedin.com", "twitter.com", "x.com", "facebook.com",
  "linktr.ee", "linktree.com", "bio.link",
  "medium.com", "substack.com", "dev.to", "hashnode.com",
  "blogspot.com", "wordpress.com", "notion.site", "notion.so",
  "carrd.co", "beehiiv.com", "ghost.io",
  "vercel.app", "netlify.app", "pages.dev",
]);

// Company names that indicate we matched a platform, not the actual vendor.
const PLATFORM_NAMES = new Set([
  "github", "gitlab", "linkedin", "twitter", "facebook", "meta",
  "linktree", "medium", "blogspot", "wordpress", "notion", "vercel",
  "netlify", "cloudflare", "google", "microsoft", "amazon",
]);

// ── Companies API lookup ──────────────────────────────────────────────────────

async function lookupCompany(websiteUrl) {
  if (!websiteUrl?.startsWith("http")) return null;
  try {
    const hostname = new URL(websiteUrl).hostname.replace(/^www\./, "");

    // Skip known platform URLs — they'll return the platform as the "company"
    const rootDomain = hostname.split(".").slice(-2).join(".");
    if (PLATFORM_DOMAINS.has(hostname) || PLATFORM_DOMAINS.has(rootDomain)) return null;

    const res = await fetch(
      `https://api.thecompaniesapi.com/v1/companies/${encodeURIComponent(hostname)}?free=true`,
      { headers: { Authorization: `Bearer ${COMPANIES_KEY}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.name) return null;

    // Reject if the API returned a platform name (website URL redirected to a platform)
    const nameLower = data.name.toLowerCase().replace(/[^a-z]/g, "");
    if (PLATFORM_NAMES.has(nameLower)) return null;

    return {
      name: data.name,
      industry: (data.industries || []).slice(0, 3).join(", "),
    };
  } catch {
    return null;
  }
}

// ── Fetch repo stars from GitHub ──────────────────────────────────────────────

async function fetchRepoStars(repoFullName) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repoFullName}`, { headers: ghHeaders });
    if (!res.ok) return 0;
    const data = await res.json();
    return data.stargazers_count ?? 0;
  } catch {
    return 0;
  }
}

// ── Verify repo has at least one SKILL.md ─────────────────────────────────────
// Scans the repo's git tree for SKILL.md or skill.md files.
// Returns the count so we can skip orgs that have none.

async function countSkillFiles(repoFullName) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/trees/HEAD?recursive=1`,
      { headers: ghHeaders }
    );
    if (!res.ok) return 0;
    const data = await res.json();
    const SKILL_RE = /(?:^|\/)(SKILL\.md|skill\.md)$/;
    return (data.tree || []).filter(
      (item) => item.type === "blob" && SKILL_RE.test(item.path)
    ).length;
  } catch {
    return 0;
  }
}

// ── Process candidates ────────────────────────────────────────────────────────

console.log(`\nEnriching ${candidates.size} candidates (GitHub profile + Companies API)...`);

let addedOwners = 0;
let addedRepos  = 0;

for (const [ownerKey, info] of candidates) {
  // Re-check — a previous iteration may have added this owner's peer
  if (knownOwnerKeys.has(ownerKey)) continue;

  const profile = await fetchOrgProfile(info.login);
  if (!profile) continue;

  // Only accept GitHub Organizations — individual users rarely publish official vendor skills
  if (profile.type !== "Organization") continue;

  // profile.blog is GitHub's API field name for the org's declared website URL
  // (shown as the chain-link "Website" field on the org's GitHub page)
  const website = profile.blog || "";
  const websiteLive = await checkWebsiteLive(website);
  if (!websiteLive) continue; // no live website → skip

  const company = await lookupCompany(website);
  if (!company) continue; // not in company DB → skip

  // Confirm the repo actually contains SKILL.md files — skip orgs with none
  const skillCount = await countSkillFiles(info.repoFullName);
  if (skillCount === 0) {
    console.log(`  ⏭  ${ownerKey} — no SKILL.md found in ${info.repoFullName}`);
    continue;
  }

  // Confirmed as a real company with skills — fetch repo stars
  const stars = await fetchRepoStars(info.repoFullName);

  const displayName = company.name || profile.name || info.login;

  console.log(`  ✅ ${ownerKey} → ${displayName}  (${company.industry || "?"})  ⭐${stars}`);

  // Add owner
  const owner = {
    ownerKey,
    displayName,
    normalizedNames: [ownerKey],
    sourceOwnerKeys: [info.login],
    websiteHosts: [],
    website,
    sources: ["github-discovery"],
    sourceUrls: [`https://github.com/${info.login}`],
    skillsCount: 0,
    reposCount: 1,
    installsCount: 0,
    starsCount: stars,
    confidence: "high",
    dbConfirmed: true,
    companyIndustry: company.industry || "",
    firstSeenAt: now,
    lastSeenAt: now,
  };
  if (profile.twitter_username) owner.twitter = `@${profile.twitter_username}`;

  directory.officialOwners.push(owner);
  knownOwnerKeys.add(ownerKey);
  addedOwners++;

  // Add repo (if not already tracked)
  const repoKey = info.repoKey;
  if (!knownRepoKeys.has(repoKey)) {
    const repo = {
      repoKey,
      ownerKey,
      sourceOwnerKeys: [info.login],
      repoName: info.repoFullName.split("/")[1],
      displayName: info.repoFullName,
      sources: ["github-discovery"],
      sourceUrls: [`https://github.com/${info.repoFullName}`],
      skillsCount: 0,
      installsCount: 0,
      starsCount: stars,
      confidence: "medium",
      firstSeenAt: now,
      lastSeenAt: now,
      githubSkillPaths: [],
      truncated: false,
    };
    directory.officialRepos.push(repo);
    knownRepoKeys.add(repoKey);
    addedRepos++;
  }
}

// ── Update stats and write ────────────────────────────────────────────────────

directory.stats.owners = directory.officialOwners.length;
directory.stats.repos  = directory.officialRepos.length;
directory.generatedAt  = now;

await fs.writeFile(DATA_PATH, `${JSON.stringify(directory, null, 2)}\n`);

console.log(`\n✅ Added ${addedOwners} new owners, ${addedRepos} new repos`);
console.log(`Directory: ${directory.stats.owners} owners, ${directory.stats.repos} repos`);
