/**
 * Enriches the official skills directory with actual SKILL.md files fetched
 * from GitHub, replacing catalog-reported skill counts with ground truth.
 *
 * Run after scrape_official_skills.mjs:
 *   GITHUB_TOKEN=$(gh auth token) npm run enrich:github-skills
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const DATA_PATH =
  process.env.OFFICIAL_SKILLS_OUTPUT ||
  path.join(root, "data", "official-skills-universal.json");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const CONCURRENCY = Number(process.env.GITHUB_SKILLS_CONCURRENCY || (GITHUB_TOKEN ? 10 : 2));
const SKILLS_SH_INSTALLS_CONCURRENCY = Number(process.env.SKILLS_SH_INSTALLS_CONCURRENCY || 6);
const SKILLS_SH_INSTALLS_ENABLED = process.env.SKILLS_SH_INSTALLS !== "0";
const SKILLS_SH_FETCH_TIMEOUT_MS = Number(process.env.SKILLS_SH_FETCH_TIMEOUT_MS || 10000);
const GITHUB_SKILL_TREES_ENABLED = process.env.GITHUB_SKILL_TREES !== "0";
const SKILLS_SH_ORIGIN = "https://www.skills.sh";

if (!GITHUB_TOKEN) {
  console.error("GITHUB_TOKEN is required. Run: GITHUB_TOKEN=$(gh auth token) npm run enrich:github-skills");
  process.exit(1);
}

const generatedAt = new Date().toISOString();
const directory = JSON.parse(await fs.readFile(DATA_PATH, "utf8"));

console.log(
  `Loaded ${directory.officialRepos.length} repos, ${directory.officialSkills.length} skills from ${DATA_PATH}`
);

if (GITHUB_SKILL_TREES_ENABLED) {
  await enrichWithGitHubSkillTrees(directory);
} else {
  console.log("GitHub skill tree fetching skipped by GITHUB_SKILL_TREES=0");
}
if (SKILLS_SH_INSTALLS_ENABLED) {
  await enrichWithSkillsShInstalls(directory);
}
await enrichStarCounts(directory);
refreshStats(directory);

directory.enrichedAt = generatedAt;
await fs.writeFile(DATA_PATH, `${JSON.stringify(directory, null, 2)}\n`);
console.log(`Wrote ${DATA_PATH}`);
console.log(
  `Directory: ${directory.stats.owners} owners, ${directory.stats.repos} repos, ${directory.stats.skills} skills`
);

// ── GitHub skill tree fetching ─────────────────────────────────────────────

async function enrichWithGitHubSkillTrees(directory) {
  const repos = directory.officialRepos;
  console.log(`Fetching GitHub skill trees for ${repos.length} repos (concurrency ${CONCURRENCY})...`);

  let fetched = 0;
  let failed = 0;
  let rateLimited = false;

  await mapWithConcurrency(repos, CONCURRENCY, async (repo) => {
    if (rateLimited) return;
    const result = await fetchGitHubRepoSkillPaths(repo);
    if (result === "rate_limited") {
      rateLimited = true;
      console.warn("GitHub API rate limited — stopping early");
      return;
    }
    if (result) {
      repo.githubSkillPaths = result.skillPaths;
      repo.truncated = result.truncated;
      fetched++;
    } else {
      failed++;
    }
  });

  console.log(`GitHub skill trees: ${fetched} fetched, ${failed} failed/not-found`);
  if (rateLimited) return;

  reconcileSkillsWithGitHub(directory);
}

async function fetchGitHubRepoSkillPaths(repo) {
  const repoKey = repo.repoKey;
  const skillPathPrefixes = repo.skillPathPrefixes || repo.githubSkillPathPrefixes || [];
  const headers = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "Skillscout official skills enricher",
    Authorization: `Bearer ${GITHUB_TOKEN}`,
  };

  try {
    const response = await fetch(
      `https://api.github.com/repos/${repoKey}/git/trees/HEAD?recursive=1`,
      { headers }
    );
    if (response.status === 404) return null;
    if (response.status === 403 || response.status === 429) return "rate_limited";
    if (!response.ok) return null;

    const data = await response.json();

    const skillPaths = [];
    const SKILL_RE = /(?:^|\/)(SKILL\.md|skill\.md)$/;
    for (const item of data.tree || []) {
      if (item.type !== "blob") continue;
      const match = item.path.match(SKILL_RE);
      if (!match) continue;
      if (isTemplateSkillFilePath(item.path)) continue;
      if (skillPathPrefixes.length && !skillPathPrefixes.some((prefix) => item.path.startsWith(prefix))) {
        continue;
      }

      if (item.path === match[1]) {
        skillPaths.push(normalizeKey(repoKey.split("/")[1]));
      } else {
        const skillPath = item.path.slice(0, -`/${match[1]}`.length);
        skillPaths.push(normalizeKey(skillPath));
      }
    }

    return { skillPaths, truncated: Boolean(data.truncated) };
  } catch {
    return null;
  }
}

function reconcileSkillsWithGitHub(directory) {
  const githubByRepo = new Map();
  for (const repo of directory.officialRepos) {
    if (repo.githubSkillPaths) {
      githubByRepo.set(repo.repoKey, new Set(repo.githubSkillPaths));
    }
  }
  if (!githubByRepo.size) return;

  for (const [repoKey, githubPaths] of githubByRepo) {
    const repo = directory.officialRepos.find((r) => r.repoKey === repoKey);
    if (!repo) continue;

    const ownerKey = repo.ownerKey;

    // Preserve install counts from catalog skills for matched names
    const catalogInstalls = new Map();
    const catalogDescriptions = new Map();
    for (const skill of directory.officialSkills) {
      if (skill.repoKey !== repoKey) continue;
      const slug = normalizeKey(skill.skillName || skill.displayName);
      catalogInstalls.set(slug, Math.max(catalogInstalls.get(slug) || 0, skill.installsCount || 0));
      if (skill.description) {
        catalogDescriptions.set(slug, skill.description);
      }
    }

    // Replace ALL existing skills for this repo with GitHub ground truth.
    // Must drop previous github-sourced entries too, otherwise repeated
    // enrichment runs layer duplicate skillKeys into the array.
    directory.officialSkills = directory.officialSkills.filter(
      (s) => s.repoKey !== repoKey
    );

    for (const skillPath of githubPaths) {
      const skillName = skillPath.split("/").pop();
      const skillKey = `${repoKey}/${skillPath}`;
      const installs = catalogInstalls.get(skillPath) || catalogInstalls.get(skillName) || 0;
      const description = catalogDescriptions.get(skillPath) || catalogDescriptions.get(skillName) || "";

      directory.officialSkills.push({
        skillKey,
        ownerKey,
        sourceOwnerKeys: repo.sourceOwnerKeys?.slice() || [ownerKey],
        repoKey,
        skillName,
        displayName: skillName,
        description,
        sources: ["github"],
        sourceUrls: [`https://github.com/${repoKey}/tree/HEAD/${skillPath}`],
        installsCount: installs,
        confidence: "high",
        firstSeenAt: generatedAt,
        lastSeenAt: generatedAt,
      });
    }

    if (!repo.truncated) {
      repo.skillsCount = githubPaths.size;
    }
  }

  // Drop standalone skills (no repoKey) for any owner that has GitHub-verified repo skills.
  // Standalone entries from mcpservers.org can't be mapped to a specific repo/file,
  // so they would inflate counts for owners where we have ground truth.
  // Only owners with zero GitHub data keep their standalone skills.
  const ownersWithGithubData = new Set();
  for (const [repoKey] of githubByRepo) {
    const repo = directory.officialRepos.find((r) => r.repoKey === repoKey);
    if (repo) ownersWithGithubData.add(repo.ownerKey);
  }

  const beforeStandaloneRemoval = directory.officialSkills.length;
  directory.officialSkills = directory.officialSkills.filter(
    (s) => s.repoKey || !ownersWithGithubData.has(s.ownerKey)
  );
  const removedStandalone = beforeStandaloneRemoval - directory.officialSkills.length;
  if (removedStandalone > 0) {
    console.log(`Removed ${removedStandalone} unmappable standalone skills from GitHub-verified owners`);
  }

  directory.officialSkills.sort((a, b) => a.skillKey.localeCompare(b.skillKey));

  // Recompute owner skillsCount from actual skills
  const skillCountByOwner = new Map();
  for (const skill of directory.officialSkills) {
    skillCountByOwner.set(skill.ownerKey, (skillCountByOwner.get(skill.ownerKey) || 0) + 1);
  }
  for (const owner of directory.officialOwners) {
    const count = skillCountByOwner.get(owner.ownerKey);
    if (count != null) owner.skillsCount = count;
  }

  directory.stats.skills = directory.officialSkills.length;

  const verified = directory.officialSkills.filter((s) => s.sources.includes("github")).length;
  console.log(
    `Reconciled: ${githubByRepo.size} repos verified, ${verified} skills from GitHub`
  );
}

// ── skills.sh install count enrichment ─────────────────────────────────────

async function enrichWithSkillsShInstalls(directory) {
  const repoSkillUrls = findSkillsShRepoUrls(directory);
  const repos = directory.officialRepos.filter((repo) => {
    if (!repoSkillUrls.has(repo.repoKey)) return false;
    return Number(repo.installsCount || 0) === 0 || repoNeedsSkillsShMapping(directory, repo.repoKey);
  });

  if (!repos.length) {
    console.log("skills.sh installs: mapped repos already have install metadata");
    return;
  }

  console.log(
    `Fetching skills.sh installs for ${repos.length} mapped repos (concurrency ${SKILLS_SH_INSTALLS_CONCURRENCY})...`
  );

  const skillsByRepo = new Map();
  for (const skill of directory.officialSkills || []) {
    if (!skill.repoKey) continue;
    const list = skillsByRepo.get(skill.repoKey) || [];
    list.push(skill);
    skillsByRepo.set(skill.repoKey, list);
  }

  let fetched = 0;
  let updatedSkills = 0;
  let failed = 0;

  await mapWithConcurrency(repos, SKILLS_SH_INSTALLS_CONCURRENCY, async (repo) => {
    const repoUrl = repoSkillUrls.get(repo.repoKey);
    const skillInstalls = await fetchSkillsShRepoInstalls(repoUrl, repo.repoKey);
    if (!skillInstalls) {
      failed++;
      return;
    }

    fetched++;
    const skills = skillsByRepo.get(repo.repoKey) || [];
    const matchedSkillKeys = new Set();

    resetSkillsShInstallMetadata(repo, skills);

    const skillsForMatching = skills.slice().sort((a, b) => skillSpecificity(b) - skillSpecificity(a));
    const matchedInstallUrls = new Set();
    let repoOnlyInstallTotal = 0;
    const fetchedRepoInstallTotal = sumInstallRecords(skillInstalls);

    for (const skill of skillsForMatching) {
      const installRecord = matchSkillsShInstallRecord(skillInstalls, skill);
      if (!installRecord) continue;
      if (matchedInstallUrls.has(installRecord.url)) continue;

      applySkillsShInstallRecord(skill, installRecord);
      matchedSkillKeys.add(skill.skillKey);
      matchedInstallUrls.add(installRecord.url);
      updatedSkills++;
    }

    if (!matchedSkillKeys.size) {
      if (skills.length === 1 && skillInstalls.length) {
        applyAggregateSkillsShInstallRecords(skills[0], skillInstalls);
        matchedSkillKeys.add(skills[0].skillKey);
        updatedSkills++;
      } else if (skillInstalls.length === 1) {
        repoOnlyInstallTotal = Number(skillInstalls[0].installs || 0);
      }
    }

    const repoTotal = Math.max(
      sumMappedInstalls(skills, matchedSkillKeys),
      repoOnlyInstallTotal,
      fetchedRepoInstallTotal
    );
    if (repoTotal > 0 || matchedSkillKeys.size > 0) {
      addUnique(repo.sources, "skills.sh");
      addUnique(repo.sourceUrls, repoUrl);
      repo.installsCount = Math.max(Number(repo.installsCount || 0), repoTotal);
      repo.confidence = "high";
    }
  });

  recomputeInstallTotals(directory);
  console.log(
    `skills.sh installs: ${fetched} repos fetched, ${updatedSkills} skills updated, ${failed} failed/not-found`
  );
}

function findSkillsShRepoUrls(directory) {
  const repoUrls = new Map();
  for (const repo of directory.officialRepos || []) {
    const repoUrl = findSkillsShRepoUrl(repo);
    if (repoUrl) repoUrls.set(repo.repoKey, repoUrl);
  }
  return repoUrls;
}

function findSkillsShRepoUrl(repo) {
  const expectedPath = `/${repo.repoKey}`;
  for (const url of repo.sourceUrls || []) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== "www.skills.sh") continue;
      if (parsed.pathname.replace(/\/$/, "") === expectedPath) {
        return `${SKILLS_SH_ORIGIN}${expectedPath}`;
      }
      if (parsed.pathname.replace(/\/$/, "") === "/official" && parsed.hash === `#${repo.repoKey}`) {
        return `${SKILLS_SH_ORIGIN}${expectedPath}`;
      }
    } catch {
      // Continue scanning source URLs.
    }
  }

  if (repo.sources?.includes("skills.sh")) {
    return `${SKILLS_SH_ORIGIN}/${repo.repoKey}`;
  }

  if (repoHasGitHubSource(repo) && repo.repoKey?.includes("/")) {
    return `${SKILLS_SH_ORIGIN}/${repo.repoKey}`;
  }

  return "";
}

function repoHasGitHubSource(repo) {
  if (repo.sources?.some((source) => source === "github" || source === "github-discovery")) {
    return true;
  }
  return (repo.sourceUrls || []).some((url) => {
    try {
      return new URL(url).hostname === "github.com";
    } catch {
      return false;
    }
  });
}

function repoNeedsSkillsShMapping(directory, repoKey) {
  return (directory.officialSkills || []).some(
    (skill) =>
      skill.repoKey === repoKey &&
      (Number(skill.installsCount || 0) === 0 || !skill.sources?.includes("skills.sh"))
  );
}

async function fetchSkillsShRepoInstalls(repoUrl, repoKey) {
  try {
    const repoHtml = await fetchSkillsShHtml(repoUrl);
    const repoRecords = parseSkillsShRepoInstallRecords(repoHtml, repoKey);
    if (repoRecords.length && repoRecords.every((record) => record.installs > 0)) {
      return repoRecords;
    }

    const skillUrls = extractSkillsShSkillUrls(repoHtml, repoKey);
    if (!skillUrls.length) return repoRecords.length ? repoRecords : null;

    const recordsByUrl = new Map(repoRecords.map((record) => [record.url, record]));
    await mapWithConcurrency(skillUrls, SKILLS_SH_INSTALLS_CONCURRENCY, async (url) => {
      const record = await fetchSkillsShSkillInstall(url);
      if (record) recordsByUrl.set(record.url, record);
    });

    const records = [...recordsByUrl.values()];
    return records.length ? records : null;
  } catch {
    return null;
  }
}

function parseSkillsShRepoInstallRecords(html, repoKey) {
  const records = [];
  const escapedRepoKey = escapeRegExp(repoKey);
  const linkPattern = new RegExp(`<a\\b[^>]*href="/${escapedRepoKey}/([^"#?]+)"[\\s\\S]*?<\\/a>`, "g");
  for (const match of html.matchAll(linkPattern)) {
    const block = match[0];
    const skillSlug = decodeURIComponent(match[1]).replace(/\/$/, "");
    if (!skillSlug) continue;

    const countMatch = block.match(/<span[^>]*>\s*([0-9][0-9,.]*\s*[KMB]?)\s*<\/span>/i);
    if (!countMatch) continue;

    const headingMatch = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    records.push({
      name: headingMatch ? stripHtml(headingMatch[1]) : skillSlug,
      url: `${SKILLS_SH_ORIGIN}/${repoKey}/${encodeURIComponent(skillSlug)}`,
      installs: parseInstallCount(countMatch[1]),
    });
  }
  return records;
}

async function fetchSkillsShSkillInstall(url) {
  try {
    const html = await fetchSkillsShHtml(url);
    for (const json of extractJsonLd(html)) {
      const nodes = Array.isArray(json) ? json : [json];
      for (const node of nodes) {
        if (node?.["@type"] !== "SoftwareApplication") continue;
        const installs = Number(node.interactionStatistic?.userInteractionCount);
        if (!Number.isFinite(installs)) continue;
        return {
          name: String(node.name || "").trim(),
          url: String(node.url || url),
          installs,
        };
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function fetchSkillsShHtml(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Skillscout official skills enricher",
    },
    signal: AbortSignal.timeout(SKILLS_SH_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Could not fetch ${url}: ${response.status}`);
  }
  return response.text();
}

function extractSkillsShSkillUrls(html, repoKey) {
  const urls = new Set();
  const escapedRepoKey = escapeRegExp(repoKey);
  const linkPattern = new RegExp(`href="/${escapedRepoKey}/([^"#?]+)"`, "g");
  for (const match of html.matchAll(linkPattern)) {
    const skillSlug = decodeURIComponent(match[1]).replace(/\/$/, "");
    if (!skillSlug) continue;
    urls.add(`${SKILLS_SH_ORIGIN}/${repoKey}/${encodeURIComponent(skillSlug)}`);
  }
  return [...urls];
}

function extractJsonLd(html) {
  const records = [];
  const scriptPattern = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  for (const match of html.matchAll(scriptPattern)) {
    try {
      records.push(JSON.parse(decodeHtmlEntities(match[1])));
    } catch {
      // Skip unparsable JSON-LD blocks.
    }
  }
  return records;
}

function matchSkillsShInstallRecord(records, skill) {
  if (records.length === 1 && isGenericSkillName(skill.skillName)) {
    return records[0];
  }

  const candidates = skillMatchCandidates(skill);
  let bestMatch = null;
  let bestScore = 0;

  for (const record of records) {
    const name = normalizeKey(record.name);
    const urlSlug = normalizeKey(record.url?.split("/").pop());
    if (candidates.has(name) || candidates.has(urlSlug)) {
      return record;
    }

    for (const candidate of candidates) {
      const score = scoreFuzzySkillMatch(candidate, name, urlSlug);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = record;
      }
    }
  }

  return bestScore >= 1 ? bestMatch : null;
}

function skillMatchCandidates(skill) {
  const parts = String(skill.skillKey || "").split("/").slice(2);
  const cleanedParts = parts.filter((part) => !["skills", "skill"].includes(normalizeKey(part)));
  const repoName = normalizeKey(String(skill.repoKey || "").split("/").pop());
  const ownerName = normalizeKey(skill.ownerKey);
  const values = [
    skill.skillName,
    skill.displayName,
    skill.skillKey?.split("/").pop(),
    parts.join("-"),
    cleanedParts.join("-"),
    cleanedParts.slice(-2).join("-"),
    cleanedParts.slice(-3).join("-"),
  ];

  if (normalizeKey(skill.skillName) === repoName || isGenericSkillName(skill.skillName)) {
    values.push(ownerName);
  }

  return new Set(values.map(normalizeKey).filter(Boolean));
}

function skillSpecificity(skill) {
  return Math.max(...skillMatchCandidates(skill).values().map((candidate) => candidate.length), 0);
}

function scoreFuzzySkillMatch(candidate, name, urlSlug) {
  if (!candidate || isGenericSkillName(candidate) || candidate.length < 5) return 0;
  const targets = [name, urlSlug].filter(Boolean);
  let score = 0;
  for (const target of targets) {
    if (target.endsWith(`-${candidate}`) || target.includes(`-${candidate}-`)) {
      score = Math.max(score, 1.2);
    }
    if (candidate.length >= 8 && target.includes(candidate)) {
      score = Math.max(score, 1);
    }
    const candidateTokens = candidate.split("-").filter((token) => token.length >= 3);
    if (candidateTokens.length >= 2) {
      const targetTokens = new Set(target.split("-").filter(Boolean));
      const matches = candidateTokens.filter((token) => targetTokens.has(token)).length;
      if (matches === candidateTokens.length) {
        score = Math.max(score, 1 + matches / 10);
      }
    }
  }
  return score;
}

function isGenericSkillName(value) {
  return ["skill", "skills", "claude", "codex", "setup"].includes(normalizeKey(value));
}

function applySkillsShInstallRecord(skill, installRecord) {
  addUnique(skill.sources, "skills.sh");
  addUnique(skill.sourceUrls, installRecord.url);
  skill.installsCount = Math.max(Number(skill.installsCount || 0), installRecord.installs);
  if (isGenericSkillName(skill.skillName) && installRecord.name) {
    skill.displayName = installRecord.name;
  }
  skill.confidence = "high";
}

function applyAggregateSkillsShInstallRecords(skill, installRecords) {
  const total = sumInstallRecords(installRecords);
  const primaryRecord = installRecords
    .slice()
    .sort((a, b) => Number(b.installs || 0) - Number(a.installs || 0))[0];

  addUnique(skill.sources, "skills.sh");
  for (const record of installRecords) {
    addUnique(skill.sourceUrls, record.url);
  }
  skill.installsCount = total;
  if (isGenericSkillName(skill.skillName) && primaryRecord?.name) {
    skill.displayName = primaryRecord.name;
  }
  skill.confidence = "high";
}

function sumInstallRecords(installRecords) {
  return installRecords.reduce((sum, record) => sum + Number(record.installs || 0), 0);
}

function sumMappedInstalls(skills, matchedSkillKeys) {
  let total = 0;
  for (const skill of skills) {
    if (!matchedSkillKeys.has(skill.skillKey)) continue;
    total += Number(skill.installsCount || 0);
  }
  return total;
}

function resetSkillsShInstallMetadata(repo, skills) {
  repo.installsCount = 0;
  repo.sources = removeValue(repo.sources, "skills.sh");

  for (const skill of skills) {
    skill.installsCount = 0;
    skill.sources = removeValue(skill.sources, "skills.sh");
    skill.sourceUrls = (skill.sourceUrls || []).filter((url) => {
      try {
        return new URL(url).hostname !== "www.skills.sh";
      } catch {
        return true;
      }
    });
  }
}

function recomputeInstallTotals(directory) {
  const installsByRepo = new Map();
  const knownRepoKeys = new Set();
  for (const skill of directory.officialSkills || []) {
    if (!skill.repoKey) continue;
    if (skill.sources?.includes("skills.sh")) {
      knownRepoKeys.add(skill.repoKey);
      installsByRepo.set(
        skill.repoKey,
        (installsByRepo.get(skill.repoKey) || 0) + Number(skill.installsCount || 0)
      );
    }
  }

  for (const repo of directory.officialRepos || []) {
    if (!knownRepoKeys.has(repo.repoKey)) continue;
    repo.installsCount = Math.max(Number(repo.installsCount || 0), installsByRepo.get(repo.repoKey) || 0);
  }

  const installsByOwner = new Map();
  for (const repo of directory.officialRepos || []) {
    if (!repo.sources?.includes("skills.sh")) continue;
    installsByOwner.set(
      repo.ownerKey,
      (installsByOwner.get(repo.ownerKey) || 0) + Number(repo.installsCount || 0)
    );
  }

  for (const owner of directory.officialOwners || []) {
    if (!installsByOwner.has(owner.ownerKey)) continue;
    owner.installsCount = installsByOwner.get(owner.ownerKey) || 0;
    addUnique(owner.sources, "skills.sh");
    addUnique(owner.sourceUrls, `${SKILLS_SH_ORIGIN}/${owner.ownerKey}`);
  }
}

// ── Star count enrichment ─────────────────────────────────────────────────────
// Fetches real stargazers_count from GitHub for repos with starsCount === 0
// (typically newly discovered vendors). Aggregates totals up to the owner level.

async function enrichStarCounts(directory) {
  const headers = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "Skillscout official skills enricher",
    Authorization: `Bearer ${GITHUB_TOKEN}`,
  };

  const reposNeedingStars = directory.officialRepos.filter((r) => !r.starsCount);
  if (!reposNeedingStars.length) {
    console.log("Star counts: all repos already have star data, skipping fetch");
    return;
  }

  console.log(`Fetching star counts for ${reposNeedingStars.length} repos...`);
  let updated = 0;

  await mapWithConcurrency(reposNeedingStars, CONCURRENCY, async (repo) => {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo.repoKey}`, { headers });
      if (!res.ok) return;
      const data = await res.json();
      const stars = data.stargazers_count ?? 0;
      if (stars > 0) {
        repo.starsCount = stars;
        updated++;
      }
    } catch {
      // ignore individual failures
    }
  });

  console.log(`Star counts: updated ${updated} repos`);

  // Aggregate starsCount per owner (sum across all their repos)
  const starsByOwner = new Map();
  for (const repo of directory.officialRepos) {
    const s = starsByOwner.get(repo.ownerKey) || 0;
    starsByOwner.set(repo.ownerKey, s + (repo.starsCount || 0));
  }
  for (const owner of directory.officialOwners) {
    const total = starsByOwner.get(owner.ownerKey);
    if (total != null) owner.starsCount = total;
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await mapper(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&amp;/g, "and")
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isTemplateSkillFilePath(filePath) {
  return /(^|\/)templates?\/skill\/SKILL\.md$/i.test(filePath);
}

function addUnique(list, value) {
  if (!Array.isArray(list) || !value) return;
  if (!list.includes(value)) list.push(value);
}

function removeValue(list, value) {
  return Array.isArray(list) ? list.filter((item) => item !== value) : [];
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtml(value) {
  return decodeHtmlEntities(value)
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseInteger(value) {
  const parsed = Number.parseInt(String(value || "").replace(/,/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseInstallCount(value) {
  const label = String(value || "").trim().replace(/,/g, "");
  const match = label.match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMB])?$/i);
  if (!match) return parseInteger(label);

  const number = Number.parseFloat(match[1]);
  const suffix = (match[2] || "").toUpperCase();
  const multiplier = suffix === "B" ? 1_000_000_000 : suffix === "M" ? 1_000_000 : suffix === "K" ? 1_000 : 1;
  return Number.isFinite(number) ? Math.round(number * multiplier) : 0;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function refreshStats(directory) {
  directory.stats = {
    owners: directory.officialOwners.length,
    repos: directory.officialRepos.length,
    skills: directory.officialSkills.length,
    sourceOwners: countBySource(directory.officialOwners),
    sourceRepos: countBySource(directory.officialRepos),
    sourceSkills: countBySource(directory.officialSkills),
  };
}

function countBySource(items) {
  const counts = {};
  for (const item of items) {
    for (const source of item.sources || []) {
      counts[source] = (counts[source] || 0) + 1;
    }
  }
  return counts;
}
