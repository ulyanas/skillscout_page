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

if (!GITHUB_TOKEN) {
  console.error("GITHUB_TOKEN is required. Run: GITHUB_TOKEN=$(gh auth token) npm run enrich:github-skills");
  process.exit(1);
}

const generatedAt = new Date().toISOString();
const directory = JSON.parse(await fs.readFile(DATA_PATH, "utf8"));

console.log(
  `Loaded ${directory.officialRepos.length} repos, ${directory.officialSkills.length} skills from ${DATA_PATH}`
);

await enrichWithGitHubSkillTrees(directory);
await enrichStarCounts(directory);

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
    const result = await fetchGitHubRepoSkillPaths(repo.repoKey);
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

async function fetchGitHubRepoSkillPaths(repoKey) {
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
    for (const item of data.tree || []) {
      if (item.type !== "blob") continue;
      if (!item.path.endsWith("/SKILL.md") && item.path !== "SKILL.md") continue;

      if (item.path === "SKILL.md") {
        skillPaths.push(normalizeKey(repoKey.split("/")[1]));
      } else {
        const skillPath = item.path.slice(0, -"/SKILL.md".length);
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
    for (const skill of directory.officialSkills) {
      if (skill.repoKey !== repoKey) continue;
      const slug = normalizeKey(skill.skillName || skill.displayName);
      catalogInstalls.set(slug, Math.max(catalogInstalls.get(slug) || 0, skill.installsCount || 0));
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

      directory.officialSkills.push({
        skillKey,
        ownerKey,
        sourceOwnerKeys: repo.sourceOwnerKeys?.slice() || [ownerKey],
        repoKey,
        skillName,
        displayName: skillName,
        description: "",
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
