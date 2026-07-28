/**
 * Discovers new official skill vendors from GitHub and auto-adds them
 * to the official skills directory after verifying ownership through GitHub
 * and either The Companies API or GitHub's verified organization status.
 *
 * A candidate org qualifies when:
 *   1. It is a GitHub Organization (not an individual user account)
 *   2. The skill repo is owned by the org directly (not a fork)
 *   3. The org's declared website (profile.blog) is a live, non-platform URL
 *   4. The domain is recognised in The Companies API, or the GitHub org is verified
 *
 * Run:
 *   GITHUB_TOKEN=$(gh auth token) \
 *   node scripts/auto_add_vendors.mjs
 *
 * Env vars:
 *   GITHUB_TOKEN          required — GitHub API access
 *   COMPANIES_API_KEY     optional — The Companies API (thecompaniesapi.com)
 *   OFFICIAL_SKILLS_OUTPUT  optional — path to JSON (default: docs/data/official-skills-universal.json)
 *   DISCOVERY_WINDOW_DAYS   optional — days back to search (default: 45)
 *   DISCOVERY_START_DATE    optional — YYYY-MM-DD lower bound for repo pushed date
 *   DISCOVERY_END_DATE      optional — YYYY-MM-DD upper bound for repo pushed date
 *   DISCOVERY_SEARCH_PAGES  optional — GitHub pages per search query (default: 5)
 *   DISCOVERY_MAX_CANDIDATES optional — max candidate repos to verify per run (default: 2500)
 *   DISCOVERY_REJECTION_SAMPLE_LIMIT optional — sample repos to print per rejection reason (default: 5)
 *   DISCOVERY_REPORTS_OUTPUT optional — report directory (default: .discovery-reports)
 *   DISCOVERY_SKIP_SEARCH   optional — set to 1 to process manual seeds only
 *   DISCOVERY_SEED_REPOS    optional — comma/space/newline separated repo URLs or owner/repo keys
 *   DISCOVERY_SEED_ORGS     optional — comma/space/newline separated GitHub org URLs or logins
 *   DISCOVERY_SEED_FILE     optional — file containing repo URLs or owner/repo keys
 *   DRY_RUN                 optional — set to 1 to print proposed changes without writing JSON
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const DATA_PATH =
  process.env.OFFICIAL_SKILLS_OUTPUT ||
  path.join(root, "docs", "data", "official-skills-universal.json");
const REPORTS_DIR =
  process.env.DISCOVERY_REPORTS_OUTPUT ||
  path.join(root, ".discovery-reports");

const GITHUB_TOKEN    = process.env.GITHUB_TOKEN;
const COMPANIES_KEY   = process.env.COMPANIES_API_KEY;
const WINDOW_DAYS     = Number(process.env.DISCOVERY_WINDOW_DAYS || 45);
const START_DATE      = process.env.DISCOVERY_START_DATE || "";
const END_DATE        = process.env.DISCOVERY_END_DATE || "";
const SEARCH_PAGES    = Math.max(1, Number(process.env.DISCOVERY_SEARCH_PAGES || 5));
const MAX_CANDIDATES  = Math.max(1, Number(process.env.DISCOVERY_MAX_CANDIDATES || 2500));
const REJECTION_SAMPLE_LIMIT = Math.max(0, Number(process.env.DISCOVERY_REJECTION_SAMPLE_LIMIT || 5));
const SKIP_SEARCH     = process.env.DISCOVERY_SKIP_SEARCH === "1" || process.env.DISCOVERY_SKIP_SEARCH === "true";
const SEED_REPOS      = process.env.DISCOVERY_SEED_REPOS || "";
const SEED_ORGS       = process.env.DISCOVERY_SEED_ORGS || "";
const SEED_FILE       = process.env.DISCOVERY_SEED_FILE || "";
const DRY_RUN         = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

if (!GITHUB_TOKEN) {
  console.error("GITHUB_TOKEN is required.");
  process.exit(1);
}
const ghHeaders = {
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "Skillscout vendor discovery",
  Authorization: `Bearer ${GITHUB_TOKEN}`,
};

const now = new Date().toISOString();
const reportId = now.replace(/[:.]/g, "-");

// ── Load directory ────────────────────────────────────────────────────────────

const directory = JSON.parse(await fs.readFile(DATA_PATH, "utf8"));
const knownOwnerKeys = new Set(directory.officialOwners.map((o) => o.ownerKey));
const knownRepoKeys  = new Set(directory.officialRepos.map((r) => r.repoKey));
const knownSkillKeys = new Set(directory.officialSkills.map((s) => s.skillKey));

console.log(`Loaded ${knownOwnerKeys.size} owners, ${knownRepoKeys.size} repos from ${DATA_PATH}`);

// ── GitHub search ─────────────────────────────────────────────────────────────

const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
const pushedQualifier = START_DATE || END_DATE
  ? `pushed:${START_DATE || "*"}..${END_DATE || "*"}`
  : `pushed:>${since}`;
const pushedLabel = START_DATE || END_DATE
  ? `pushed ${START_DATE || "*"}..${END_DATE || "*"}`
  : `pushed since ${since}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asObject(map) {
  return Object.fromEntries([...map].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function markdownEscape(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

async function fetchWithRetry(url, options = {}) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 403 && res.status !== 429) {
      return res;
    }

    const resetSeconds = Number(res.headers.get("x-ratelimit-reset") || 0);
    const retryAfter = Number(res.headers.get("retry-after") || 0);
    const resetDelay = resetSeconds
      ? Math.max(0, resetSeconds * 1000 - Date.now()) + 1000
      : 0;
    const fallbackDelay = Math.min(60_000, 5_000 * attempt);
    const delay = retryAfter ? retryAfter * 1000 : resetDelay || fallbackDelay;
    console.warn(`  GitHub search rate limited (${res.status}) — waiting ${Math.round(delay / 1000)}s`);
    await sleep(delay);
  }

  return fetch(url, options);
}

async function runSearch(label, baseUrl) {
  const all = [];
  for (let page = 1; page <= SEARCH_PAGES; page++) {
    const separator = baseUrl.includes("?") ? "&" : "?";
    const res = await fetchWithRetry(`${baseUrl}${separator}per_page=100&page=${page}`, { headers: ghHeaders });
    if (!res.ok) {
      console.warn(`  Search failed (${res.status}) on page ${page}: ${label}`);
      break;
    }
    const data = await res.json();
    const items = data.items ?? [];
    all.push(...items);
    if (page === 1) {
      console.log(`  ${label}: ${data.total_count ?? 0} total`);
    }
    if (items.length < 100) break;
    await sleep(1200);
  }
  console.log(`    got ${all.length}`);
  return all;
}

function taggedSearchItems(items, label, kind) {
  return items.map((item) => ({
    ...item,
    _skillscoutSearchLabel: label,
    _skillscoutSearchKind: kind,
  }));
}

function codeSearchUrl(query) {
  return `https://api.github.com/search/code?q=${encodeURIComponent(query)}&sort=indexed&order=desc`;
}

function repoSearchUrl(query) {
  return `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc`;
}

console.log("\nSearching GitHub...");
const codeQueries = [
  ['SKILL.md containing "skills install"', 'filename:SKILL.md "skills install"'],
  ['SKILL.md containing "skills add"', 'filename:SKILL.md "skills add"'],
  ['SKILL.md containing "allowed-tools"', 'filename:SKILL.md "allowed-tools"'],
  ['SKILL.md containing "description:"', 'filename:SKILL.md "description:"'],
  ["SKILL.md under skills path", "filename:SKILL.md path:skills"],
  ["SKILL.md under .agents path", "filename:SKILL.md path:.agents"],
  ["all uppercase SKILL.md files", "filename:SKILL.md"],
  ["all lowercase skill.md files", "filename:skill.md"],
];
const repoQueries = [
  [`topic:agent-skills ${pushedLabel}`, `topic:agent-skills ${pushedQualifier}`],
  [`topic:claude-skills ${pushedLabel}`, `topic:claude-skills ${pushedQualifier}`],
  [`topic:codex-skills ${pushedLabel}`, `topic:codex-skills ${pushedQualifier}`],
  [`"SKILL.md" in README ${pushedLabel}`, `"SKILL.md" in:readme ${pushedQualifier}`],
  [`"agent skills" in README ${pushedLabel}`, `"agent skills" in:readme ${pushedQualifier}`],
  [`"claude skills" in README ${pushedLabel}`, `"claude skills" in:readme ${pushedQualifier}`],
  [`agent-skill repo text ${pushedLabel}`, `agent-skill in:name,description,readme ${pushedQualifier}`],
  [`claude-skill repo text ${pushedLabel}`, `claude-skill in:name,description,readme ${pushedQualifier}`],
];

const codeItems = [];
const repoItems = [];
if (!SKIP_SEARCH) {
  for (const [label, query] of codeQueries) {
    codeItems.push(
      ...taggedSearchItems(await runSearch(label, codeSearchUrl(query)), label, "code")
    );
  }
  for (const [label, query] of repoQueries) {
    repoItems.push(
      ...taggedSearchItems(await runSearch(label, repoSearchUrl(query)), label, "repo")
    );
  }
}
if (SKIP_SEARCH) {
  console.log("  DISCOVERY_SKIP_SEARCH=1 — processing manual seeds only");
}

function parseRepoKey(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("#")) return null;
  const cleaned = raw
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/(tree|blob)\/.*$/i, "")
    .replace(/[?#].*$/, "")
    .replace(/^\/+|\/+$/g, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[0]}/${parts[1]}`;
}

function parseOrgLogin(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("#")) return null;
  const cleaned = raw
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/[?#].*$/, "")
    .replace(/^\/+|\/+$/g, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length !== 1) return null;
  return parts[0];
}

async function loadSeedRepoKeys() {
  const values = [
    ...process.argv.slice(2),
    ...SEED_REPOS.split(/[\s,]+/),
  ];
  if (SEED_FILE) {
    try {
      const text = await fs.readFile(SEED_FILE, "utf8");
      values.push(...text.split(/\r?\n/));
    } catch (error) {
      console.warn(`  Seed file unreadable: ${SEED_FILE} (${error.message})`);
    }
  }
  return [...new Set(values.map(parseRepoKey).filter(Boolean))];
}

async function loadSeedOrgLogins() {
  const values = [
    ...process.argv.slice(2),
    ...SEED_ORGS.split(/[\s,]+/),
  ];
  return [...new Set(values.map(parseOrgLogin).filter(Boolean))];
}

async function fetchRepo(repoFullName) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repoFullName}`, { headers: ghHeaders });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function fetchOrgRepos(login) {
  const repos = [];
  for (let page = 1; page <= 3; page++) {
    try {
      const res = await fetch(
        `https://api.github.com/orgs/${encodeURIComponent(login)}/repos?type=public&sort=pushed&per_page=100&page=${page}`,
        { headers: ghHeaders }
      );
      if (!res.ok) break;
      const pageRepos = await res.json();
      repos.push(...pageRepos);
      if (pageRepos.length < 100) break;
      await sleep(1200);
    } catch {
      break;
    }
  }
  return repos;
}

const seedRepoKeys = await loadSeedRepoKeys();
const seedRepos = [];
for (const repoKey of seedRepoKeys) {
  const repo = await fetchRepo(repoKey);
  if (repo) seedRepos.push(repo);
  else console.warn(`  Seed repo not found: ${repoKey}`);
}
if (seedRepos.length) {
  console.log(`  manual seed repos: ${seedRepos.length}`);
}

const seedOrgLogins = await loadSeedOrgLogins();
const seedOrgRepos = [];
for (const login of seedOrgLogins) {
  const repos = await fetchOrgRepos(login);
  seedOrgRepos.push(...repos);
  if (repos.length) console.log(`  manual seed org ${login}: ${repos.length} repos`);
  else console.warn(`  Seed org has no public repos or was unreadable: ${login}`);
}

const normalizedRepoItems = repoItems.map((repo) => ({
  repository: repo,
  path: "SKILL.md",
  html_url: `${repo.html_url}/blob/HEAD/SKILL.md`,
  sourceQuery: repo._skillscoutSearchLabel,
  searchKind: repo._skillscoutSearchKind,
}));

const normalizedSeedItems = seedRepos.map((repo) => ({
  repository: repo,
  path: "SKILL.md",
  html_url: `${repo.html_url}/blob/HEAD/SKILL.md`,
  source: "manual-seed",
  sourceQuery: "manual seed repo",
  searchKind: "seed",
}));

const normalizedSeedOrgItems = seedOrgRepos.map((repo) => ({
  repository: repo,
  path: "SKILL.md",
  html_url: `${repo.html_url}/blob/HEAD/SKILL.md`,
  source: "manual-org-seed",
  sourceQuery: "manual seed org",
  searchKind: "seed",
}));

const allItems = [...normalizedSeedItems, ...normalizedSeedOrgItems, ...codeItems, ...normalizedRepoItems];

// ── Collect unique candidate repos ────────────────────────────────────────────

function normalizeLogin(login) {
  return String(login || "").toLowerCase().replace(/[^a-z0-9._/-]+/g, "-").replace(/^-+|-+$/g, "");
}

let candidates = new Map(); // repoKey → info
const candidateStats = {
  searchItems: allItems.length,
  forks: 0,
  existingRepos: 0,
  duplicateRepos: 0,
  candidateLimitSkipped: 0,
};
const candidateSourceStats = new Map();

function candidateSourceLabel(item) {
  return item.sourceQuery || item._skillscoutSearchLabel || item.source || "unknown";
}

function bumpCandidateSource(label, field) {
  const row = candidateSourceStats.get(label) || {
    items: 0,
    candidates: 0,
    selected: 0,
    existingRepos: 0,
    forks: 0,
    duplicateRepos: 0,
    candidateLimitSkipped: 0,
  };
  row[field] = (row[field] || 0) + 1;
  candidateSourceStats.set(label, row);
}

for (const item of allItems) {
  const fullName = item.repository?.full_name;
  if (!fullName) continue;
  const sourceLabel = candidateSourceLabel(item);
  bumpCandidateSource(sourceLabel, "items");

  if (item.repository?.fork) {
    candidateStats.forks++;
    bumpCandidateSource(sourceLabel, "forks");
    continue;
  }

  const [login] = fullName.split("/");
  const ownerKey = normalizeLogin(login);
  const repoKey = fullName.toLowerCase();
  if (knownRepoKeys.has(repoKey)) {
    candidateStats.existingRepos++;
    bumpCandidateSource(sourceLabel, "existingRepos");
    continue;
  }
  if (candidates.has(repoKey)) {
    candidateStats.duplicateRepos++;
    bumpCandidateSource(sourceLabel, "duplicateRepos");
    const candidate = candidates.get(repoKey);
    candidate.sourceQueries = mergeList(candidate.sourceQueries, [sourceLabel]);
    continue;
  }
  candidates.set(repoKey, {
    login,
    ownerKey,
    repoKey,
    repoFullName: fullName,
    skillFile: item.path,
    repoHtmlUrl: item.repository?.html_url,
    source: item.source || "github-search",
    searchKind: item.searchKind || item._skillscoutSearchKind || "unknown",
    sourceQueries: [sourceLabel],
  });
  bumpCandidateSource(sourceLabel, "candidates");
}

function primaryCandidateSource(candidate) {
  if (candidate.searchKind === "seed") return "manual seeds";
  return candidate.sourceQueries?.[0] || "unknown";
}

function selectCandidatesRoundRobin(candidateMap, limit) {
  if (candidateMap.size <= limit) return { selected: candidateMap, skipped: [] };

  const buckets = new Map();
  for (const [repoKey, candidate] of candidateMap) {
    const source = primaryCandidateSource(candidate);
    if (!buckets.has(source)) buckets.set(source, []);
    buckets.get(source).push([repoKey, candidate]);
  }

  const selected = new Map();
  const skipped = [];
  const bucketEntries = [...buckets.entries()];
  while (selected.size < limit) {
    let addedThisPass = false;
    for (const [, bucket] of bucketEntries) {
      const next = bucket.shift();
      if (!next) continue;
      selected.set(next[0], next[1]);
      addedThisPass = true;
      if (selected.size >= limit) break;
    }
    if (!addedThisPass) break;
  }

  for (const [, bucket] of bucketEntries) {
    skipped.push(...bucket);
  }
  return { selected, skipped };
}

const totalUniqueCandidates = candidates.size;
const selectedCandidateResult = selectCandidatesRoundRobin(candidates, MAX_CANDIDATES);
candidates = selectedCandidateResult.selected;
candidateStats.candidateLimitSkipped = selectedCandidateResult.skipped.length;
for (const [, candidate] of candidates) {
  bumpCandidateSource(primaryCandidateSource(candidate), "selected");
}
for (const [, candidate] of selectedCandidateResult.skipped) {
  bumpCandidateSource(primaryCandidateSource(candidate), "candidateLimitSkipped");
}

console.log(`\n${candidates.size} candidate repos selected from ${totalUniqueCandidates} unique new repos`);
console.log(
  `Candidates: ${candidateStats.searchItems} items, ${candidateStats.existingRepos} existing repos, ` +
  `${candidateStats.forks} forks, ${candidateStats.duplicateRepos} duplicates, ` +
  `${candidateStats.candidateLimitSkipped} skipped by limit (${MAX_CANDIDATES})`
);
console.log("Candidate sources:");
for (const [label, row] of [...candidateSourceStats].sort((a, b) => (b[1].candidates || 0) - (a[1].candidates || 0))) {
  console.log(
    `  ${label}: ${row.selected || 0} selected, ${row.candidates || 0} unique candidates, ` +
    `${row.items || 0} items, ${row.existingRepos || 0} existing, ` +
    `${row.duplicateRepos || 0} duplicates, ${row.candidateLimitSkipped || 0} skipped by limit`
  );
}

// ── Fetch GitHub org profiles ─────────────────────────────────────────────────

async function fetchOrgProfile(login) {
  try {
    const res = await fetch(`https://api.github.com/orgs/${login}`, { headers: ghHeaders });
    if (!res.ok) {
      let message = "";
      try {
        const data = await res.json();
        message = data?.message || "";
      } catch {
        message = "";
      }
      return { profile: null, status: res.status, message };
    }
    return { profile: await res.json(), status: res.status, message: "" };
  } catch (error) {
    return { profile: null, status: 0, message: error.message };
  }
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

function isPlatformWebsite(url) {
  const hostname = getWebsiteHost(url);
  if (!hostname) return false;
  const rootDomain = hostname.split(".").slice(-2).join(".");
  return PLATFORM_DOMAINS.has(hostname) || PLATFORM_DOMAINS.has(rootDomain);
}

// ── Companies API lookup ──────────────────────────────────────────────────────

async function lookupCompany(websiteUrl) {
  if (!COMPANIES_KEY) return null;
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

async function getSkillPaths(repoFullName) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/trees/HEAD?recursive=1`,
      { headers: ghHeaders }
    );
    if (!res.ok) return { paths: [], truncated: false };
    const data = await res.json();
    const SKILL_RE = /(?:^|\/)(skill\.md)$/i;
    const paths = [];
    for (const item of data.tree || []) {
      if (item.type !== "blob") continue;
      const match = item.path.match(SKILL_RE);
      if (!match) continue;
      if (isTemplateSkillFilePath(item.path)) continue;
      const suffix = `/${match[1]}`;
      paths.push(
        item.path === match[1]
          ? normalizeLogin(repoFullName.split("/")[1])
          : normalizeLogin(item.path.slice(0, -suffix.length))
      );
    }
    return { paths, truncated: Boolean(data.truncated) };
  } catch {
    return { paths: [], truncated: false };
  }
}

// ── Process candidates ────────────────────────────────────────────────────────

console.log(`\nEnriching ${candidates.size} candidates (GitHub profile + ownership checks)...`);

let addedOwners = 0;
let addedRepos  = 0;
let processedCandidates = 0;
const rejectionReasons = new Map();
const rejectionSamples = new Map();
const acceptedSamples = [];
const rejectedItems = [];
const acceptedItems = [];

function reject(reason, info, detail = "") {
  rejectionReasons.set(reason, (rejectionReasons.get(reason) || 0) + 1);
  rejectedItems.push({
    reason,
    detail,
    repoFullName: info?.repoFullName || "",
    repoKey: info?.repoKey || "",
    ownerLogin: info?.login || "",
    ownerKey: info?.ownerKey || "",
    source: info?.source || "",
    sourceQueries: info?.sourceQueries || [],
    repoUrl: info?.repoFullName ? `https://github.com/${info.repoFullName}` : "",
    ownerUrl: info?.login ? `https://github.com/${info.login}` : "",
  });
  if (REJECTION_SAMPLE_LIMIT > 0) {
    const samples = rejectionSamples.get(reason) || [];
    if (samples.length < REJECTION_SAMPLE_LIMIT) {
      const source = info?.sourceQueries?.length ? ` via ${info.sourceQueries.join(" | ")}` : "";
      const suffix = detail ? ` — ${detail}` : "";
      samples.push(`${info?.repoFullName || "unknown"}${source}${suffix}`);
      rejectionSamples.set(reason, samples);
    }
  }
  if (info?.source === "manual-seed") {
    console.log(`  ⏭  ${info.repoFullName} — ${reason}${detail ? ` (${detail})` : ""}`);
  }
}

function mergeList(existing, additions) {
  return [...new Set([...(existing || []), ...additions].filter(Boolean))];
}

function isTemplateSkillFilePath(filePath) {
  return /(^|\/)templates?\/skill\/SKILL\.md$/i.test(filePath);
}

for (const [, info] of candidates) {
  processedCandidates++;
  if (processedCandidates % 250 === 0) {
    console.log(
      `  Progress: checked ${processedCandidates}/${candidates.size}, ` +
      `${addedOwners} new owners, ${addedRepos} new repos accepted`
    );
  }
  if (knownRepoKeys.has(info.repoKey)) {
    reject("existing repo", info);
    continue;
  }

  const { profile, status, message } = await fetchOrgProfile(info.login);
  if (!profile) {
    const reason = status === 404
      ? "org profile not found (likely user account)"
      : `org profile unavailable (${status || "request failed"})`;
    reject(reason, info, message);
    continue;
  }

  if (profile.type !== "Organization") {
    reject("not a GitHub Organization", info);
    continue;
  }

  const existingOwner = directory.officialOwners.find((owner) => owner.ownerKey === info.ownerKey);
  let website = "";
  let company = null;
  const verifiedByGitHub = profile.is_verified === true;

  if (!existingOwner) {
    // profile.blog is GitHub's API field name for the org's declared website URL
    // (shown as the chain-link "Website" field on the org's GitHub page)
    website = normalizeWebsiteUrl(profile.blog || "");
    if (isPlatformWebsite(website)) {
      reject("website is platform URL", info, website);
      continue;
    }
    company = await lookupCompany(website);
    if (!company && !verifiedByGitHub) {
      reject("not company-confirmed or GitHub verified", info, website);
      continue;
    }
    const websiteLive = await checkWebsiteLive(website);
    if (!websiteLive) {
      reject("website unavailable", info, website || "empty website");
      continue;
    }
  }

  const { paths: skillPaths, truncated } = await getSkillPaths(info.repoFullName);
  if (skillPaths.length === 0) {
    reject("no SKILL.md or skill.md found", info);
    continue;
  }

  const stars = await fetchRepoStars(info.repoFullName);
  let displayName = existingOwner?.displayName || profile.name || info.login;

  if (!existingOwner) {
    displayName = company?.name || displayName;

    const owner = {
      ownerKey: info.ownerKey,
      displayName,
      normalizedNames: [info.ownerKey],
      sourceOwnerKeys: [info.login],
      websiteHosts: [],
      website,
      sources: ["github-discovery"],
      sourceUrls: [`https://github.com/${info.login}`],
      skillsCount: 0,
      reposCount: 0,
      installsCount: 0,
      starsCount: stars,
      confidence: "high",
      dbConfirmed: Boolean(company),
      githubVerified: verifiedByGitHub,
      companyIndustry: company?.industry || "",
      firstSeenAt: now,
      lastSeenAt: now,
    };
    if (profile.twitter_username) owner.twitter = `@${profile.twitter_username}`;

    directory.officialOwners.push(owner);
    knownOwnerKeys.add(info.ownerKey);
    addedOwners++;
  } else {
    existingOwner.sourceOwnerKeys = mergeList(existingOwner.sourceOwnerKeys, [info.login]);
    existingOwner.sources = mergeList(existingOwner.sources, ["github-discovery"]);
    existingOwner.sourceUrls = mergeList(existingOwner.sourceUrls, [`https://github.com/${info.login}`]);
    existingOwner.lastSeenAt = now;
    existingOwner.starsCount = Number(existingOwner.starsCount || 0) + stars;
  }

  console.log(`  ✅ ${info.repoKey} → ${displayName}  skills:${skillPaths.length}  ⭐${stars}`);
  acceptedSamples.push(`${info.repoKey} → ${displayName} (${skillPaths.length} skills)`);
  acceptedItems.push({
    repoFullName: info.repoFullName,
    repoKey: info.repoKey,
    ownerLogin: info.login,
    ownerKey: info.ownerKey,
    displayName,
    skillCount: skillPaths.length,
    stars,
    existingOwner: Boolean(existingOwner),
    sourceQueries: info.sourceQueries || [],
    repoUrl: `https://github.com/${info.repoFullName}`,
    ownerUrl: `https://github.com/${info.login}`,
  });

  // Add repo (if not already tracked)
  const repoKey = info.repoKey;
  if (!knownRepoKeys.has(repoKey)) {
    const repo = {
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
      confidence: "medium",
      firstSeenAt: now,
      lastSeenAt: now,
      githubSkillPaths: skillPaths,
      truncated,
    };
    directory.officialRepos.push(repo);
    knownRepoKeys.add(repoKey);
    addedRepos++;
  }

  for (const skillPath of skillPaths) {
    const skillKey = `${repoKey}/${skillPath}`;
    if (knownSkillKeys.has(skillKey)) continue;
    const skillName = skillPath.split("/").pop();
    directory.officialSkills.push({
      skillKey,
      ownerKey: info.ownerKey,
      sourceOwnerKeys: [info.login],
      repoKey,
      skillName,
      displayName: skillName,
      description: "",
      sources: ["github"],
      sourceUrls: [`https://github.com/${info.repoFullName}/tree/HEAD/${skillPath}`],
      installsCount: 0,
      confidence: "high",
      firstSeenAt: now,
      lastSeenAt: now,
    });
    knownSkillKeys.add(skillKey);
  }
}

// ── Update stats and write ────────────────────────────────────────────────────

directory.officialOwners.sort((a, b) => a.ownerKey.localeCompare(b.ownerKey));
directory.officialRepos.sort((a, b) => a.repoKey.localeCompare(b.repoKey));

const reposByOwner = new Map();
const repoSkillsByOwner = new Map();
const repoStarsByOwner = new Map();
for (const repo of directory.officialRepos) {
  reposByOwner.set(repo.ownerKey, (reposByOwner.get(repo.ownerKey) || 0) + 1);
  repoSkillsByOwner.set(repo.ownerKey, (repoSkillsByOwner.get(repo.ownerKey) || 0) + Number(repo.skillsCount || 0));
  repoStarsByOwner.set(repo.ownerKey, (repoStarsByOwner.get(repo.ownerKey) || 0) + Number(repo.starsCount || 0));
}
for (const owner of directory.officialOwners) {
  owner.reposCount = reposByOwner.get(owner.ownerKey) || 0;
  const skillCount = repoSkillsByOwner.get(owner.ownerKey);
  if (skillCount != null) owner.skillsCount = skillCount;
  owner.starsCount = repoStarsByOwner.get(owner.ownerKey) || Number(owner.starsCount || 0);
}

directory.stats.owners = directory.officialOwners.length;
directory.stats.repos  = directory.officialRepos.length;
directory.stats.skills = directory.officialSkills.length;
directory.generatedAt  = now;

if (DRY_RUN) {
  console.log("\nDRY_RUN=1 — no file changes written");
} else {
  await fs.writeFile(DATA_PATH, `${JSON.stringify(directory, null, 2)}\n`);
}

function buildMarkdownReport(report) {
  const lines = [
    `# Skillscout discovery report`,
    "",
    `Run: \`${report.run.id}\``,
    `Generated: \`${report.run.generatedAt}\``,
    `Window: \`${report.run.pushedLabel}\``,
    `Dry run: \`${report.run.dryRun}\``,
    "",
    "## Summary",
    "",
    `- Search items: ${report.candidates.searchItems}`,
    `- Unique new repos: ${report.candidates.totalUnique}`,
    `- Selected repos: ${report.candidates.selected}`,
    `- Existing repos skipped: ${report.candidates.existingRepos}`,
    `- Duplicate repos skipped: ${report.candidates.duplicateRepos}`,
    `- Candidate limit skipped: ${report.candidates.candidateLimitSkipped}`,
    `- Added owners: ${report.results.addedOwners}`,
    `- Added repos: ${report.results.addedRepos}`,
    `- Directory: ${report.directory.owners} owners, ${report.directory.repos} repos, ${report.directory.skills} skills`,
    "",
    "## Rejection Counts",
    "",
  ];

  for (const [reason, count] of Object.entries(report.rejections.counts)) {
    lines.push(`- ${reason}: ${count}`);
  }

  lines.push("", "## Candidate Sources", "");
  lines.push("| Source | Selected | Unique candidates | Items | Existing | Duplicates | Limit skipped |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const [source, row] of Object.entries(report.candidates.sources)) {
    lines.push(
      `| ${markdownEscape(source)} | ${row.selected || 0} | ${row.candidates || 0} | ` +
      `${row.items || 0} | ${row.existingRepos || 0} | ${row.duplicateRepos || 0} | ${row.candidateLimitSkipped || 0} |`
    );
  }

  lines.push("", "## Unconfirmed Organizations", "");
  if (report.rejections.unconfirmedOrganizations.length === 0) {
    lines.push("No unconfirmed organizations in this run.");
  } else {
    lines.push("| Owner | Repo | Website | Sources |");
    lines.push("|---|---|---|---|");
    for (const item of report.rejections.unconfirmedOrganizations) {
      lines.push(
        `| [${markdownEscape(item.ownerLogin)}](${item.ownerUrl}) | ` +
        `[${markdownEscape(item.repoFullName)}](${item.repoUrl}) | ` +
        `${markdownEscape(item.detail || "")} | ${markdownEscape(item.sourceQueries.join(", "))} |`
      );
    }
  }

  lines.push("", "## Accepted Repos", "");
  if (report.results.accepted.length === 0) {
    lines.push("No repos accepted in this run.");
  } else {
    lines.push("| Owner | Repo | Skills | Existing owner | Sources |");
    lines.push("|---|---|---:|---|---|");
    for (const item of report.results.accepted) {
      lines.push(
        `| [${markdownEscape(item.ownerLogin)}](${item.ownerUrl}) | ` +
        `[${markdownEscape(item.repoFullName)}](${item.repoUrl}) | ` +
        `${item.skillCount} | ${item.existingOwner ? "yes" : "no"} | ` +
        `${markdownEscape(item.sourceQueries.join(", "))} |`
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

async function writeDiscoveryReport() {
  const rejectionCounts = asObject(rejectionReasons);
  const rejectionSamplesObject = asObject(rejectionSamples);
  const report = {
    run: {
      id: reportId,
      generatedAt: now,
      dryRun: DRY_RUN,
      dataPath: path.relative(root, DATA_PATH),
      reportsDir: path.relative(root, REPORTS_DIR),
      pushedLabel,
      config: {
        windowDays: WINDOW_DAYS,
        startDate: START_DATE,
        endDate: END_DATE,
        searchPages: SEARCH_PAGES,
        maxCandidates: MAX_CANDIDATES,
        rejectionSampleLimit: REJECTION_SAMPLE_LIMIT,
        skipSearch: SKIP_SEARCH,
      },
    },
    candidates: {
      searchItems: candidateStats.searchItems,
      totalUnique: totalUniqueCandidates,
      selected: candidates.size,
      forks: candidateStats.forks,
      existingRepos: candidateStats.existingRepos,
      duplicateRepos: candidateStats.duplicateRepos,
      candidateLimitSkipped: candidateStats.candidateLimitSkipped,
      sources: asObject(candidateSourceStats),
    },
    rejections: {
      counts: rejectionCounts,
      samples: rejectionSamplesObject,
      all: rejectedItems,
      unconfirmedOrganizations: rejectedItems.filter((item) =>
        item.reason === "not company-confirmed or GitHub verified"
      ),
    },
    results: {
      addedOwners,
      addedRepos,
      accepted: acceptedItems,
    },
    directory: {
      owners: directory.stats.owners,
      repos: directory.stats.repos,
      skills: directory.stats.skills,
    },
  };

  await fs.mkdir(REPORTS_DIR, { recursive: true });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = buildMarkdownReport(report);
  await fs.writeFile(path.join(REPORTS_DIR, `${reportId}.json`), json);
  await fs.writeFile(path.join(REPORTS_DIR, `${reportId}.md`), markdown);
  await fs.writeFile(path.join(REPORTS_DIR, "latest.json"), json);
  await fs.writeFile(path.join(REPORTS_DIR, "latest.md"), markdown);
  console.log(`\nWrote discovery report: ${path.relative(root, path.join(REPORTS_DIR, `${reportId}.json`))}`);
  console.log(`Wrote latest discovery report: ${path.relative(root, path.join(REPORTS_DIR, "latest.md"))}`);
}

if (!DRY_RUN) {
  await writeDiscoveryReport();
}

console.log("\nRejection summary:");
for (const [reason, count] of [...rejectionReasons].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${reason}: ${count}`);
  const samples = rejectionSamples.get(reason) || [];
  for (const sample of samples) {
    console.log(`    sample: ${sample}`);
  }
}
if (rejectionReasons.size === 0) {
  console.log("  none");
}
if (acceptedSamples.length) {
  console.log("\nAccepted samples:");
  for (const sample of acceptedSamples.slice(0, 20)) {
    console.log(`  ${sample}`);
  }
}

console.log(`\n✅ Added ${addedOwners} new owners, ${addedRepos} new repos`);
console.log(`Directory: ${directory.stats.owners} owners, ${directory.stats.repos} repos, ${directory.stats.skills} skills`);
