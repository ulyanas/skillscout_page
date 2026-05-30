import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const OUTPUT_PATH = process.env.OFFICIAL_SKILLS_OUTPUT || path.join(root, "data", "official-skills-universal.json");
const SKILLS_SH_OFFICIAL_URL = "https://www.skills.sh/official";
const MCPSERVERS_OFFICIAL_URL = "https://mcpservers.org/agent-skills/official";
const MCPSERVERS_ORIGIN = "https://mcpservers.org";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_STARS_CONCURRENCY = Number(process.env.GITHUB_STARS_CONCURRENCY || (GITHUB_TOKEN ? 10 : 2));
const OWNER_KEY_ALIASES = new Map([
  ["anthropic", "anthropics"],
  ["sentry", "getsentry"],
  ["notion", "makenotion"],
  ["neon", "neondatabase"],
  ["googleworkspace", "google"]
]);

const generatedAt = new Date().toISOString();
const sourceFetches = {};
const sourceRecords = [];

const skillsSh = await fetchTextSource("skills.sh", SKILLS_SH_OFFICIAL_URL);
sourceRecords.push(...parseSkillsShOfficial(skillsSh.text));

// mcpservers.org: fetch the main official page only for owner discovery.
// Per-author pages are skipped — they only produce standalone skills that get
// replaced by GitHub ground truth during enrichment anyway.
const mcpservers = await fetchTextSource("mcpservers.org", MCPSERVERS_OFFICIAL_URL);
const mcpOfficialAuthors = parseMcpserversOfficialAuthors(mcpservers.text);
sourceRecords.push(...mcpOfficialAuthors);

const directory = buildUniversalDirectory(sourceRecords);

// Enrich repos with GitHub stars, then aggregate to owners
await enrichWithGitHubStars(directory);
aggregateOwnerStars(directory);

// Preserve github-discovery entries from the existing file so the scrape
// doesn't wipe vendors that were added by auto_add_vendors.mjs.
await mergeDiscoveredVendors(directory);

await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(directory, null, 2)}\n`);

console.log(`Wrote ${OUTPUT_PATH}`);
console.log(
  `Official directory: ${directory.stats.owners} owners, ${directory.stats.repos} repos, ${directory.stats.skills} skills`
);

async function fetchTextSource(fetchId, url, { sourceId = fetchId } = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/json",
      "User-Agent": "Skillscout official skills scraper"
    }
  });
  const text = await response.text();
  sourceFetches[fetchId] = {
    sourceId,
    url,
    fetchedAt: generatedAt,
    status: response.status,
    etag: response.headers.get("etag"),
    hash: hashText(text),
    bytes: Buffer.byteLength(text)
  };

  if (!response.ok) {
    throw new Error(`Could not fetch ${url}: ${response.status}`);
  }

  return { text, response };
}

function parseSkillsShOfficial(html) {
  const normalizedHtml = html
    .replaceAll('\\"', '"')
    .replaceAll("\\u0026", "&")
    .replaceAll("\\/", "/");
  const ownersIndex = normalizedHtml.indexOf('"owners":[');
  if (ownersIndex < 0) {
    throw new Error("Could not find skills.sh owners payload.");
  }

  const payloadStart = normalizedHtml.lastIndexOf("{", ownersIndex);
  const payload = extractBalancedJson(normalizedHtml, payloadStart);
  const data = JSON.parse(payload);
  const records = [];

  for (const ownerRecord of data.owners || []) {
    const sourceOwnerKey = normalizeKey(ownerRecord.owner);
    const ownerKey = normalizeOwnerKey(ownerRecord.owner);
    if (!ownerKey) {
      continue;
    }

    records.push({
      type: "owner",
      sourceId: "skills.sh",
      ownerKey,
      sourceOwnerKey,
      displayName: ownerRecord.owner,
      reposCount: Number(ownerRecord.repos?.length || 0),
      skillsCount: Number(ownerRecord.totalSkills || countSkills(ownerRecord.repos)),
      installsCount: Number(ownerRecord.totalInstalls || 0),
      sourceUrl: `${SKILLS_SH_OFFICIAL_URL}#${ownerKey}`
    });

    for (const repoRecord of ownerRecord.repos || []) {
      const repoKey = normalizeRepoKey(repoRecord.repo);
      if (!repoKey) {
        continue;
      }

      const [, repoName = ""] = repoKey.split("/");
      records.push({
        type: "repo",
        sourceId: "skills.sh",
        ownerKey,
        sourceOwnerKey,
        repoKey,
        repoName,
        displayName: repoRecord.repo,
        skillsCount: Number(repoRecord.skills?.length || 0),
        installsCount: Number(repoRecord.totalInstalls || 0),
        sourceUrl: `${SKILLS_SH_OFFICIAL_URL}#${repoKey}`
      });

      for (const skillRecord of repoRecord.skills || []) {
        const skillName = String(skillRecord.name || "").trim();
        const skillKey = buildSkillKey({ ownerKey, repoKey, skillName });
        if (!skillKey) {
          continue;
        }

        records.push({
          type: "skill",
          sourceId: "skills.sh",
          ownerKey,
          sourceOwnerKey,
          repoKey,
          skillName,
          skillKey,
          displayName: skillName,
          installsCount: Number(skillRecord.installs || 0),
          sourceUrl: `https://www.skills.sh/${repoKey}/${encodeURIComponent(skillName)}`
        });
      }
    }
  }

  return records;
}

function parseMcpserversOfficialAuthors(html) {
  const records = [];
  const regex =
    /<a href="\/agent-skills\/author\/([^"]+)"[\s\S]*?<h3[^>]*>([^<]+)<\/h3><p[^>]*>([0-9,]+) skills<\/p>/g;

  for (const match of html.matchAll(regex)) {
    const sourceOwnerKey = normalizeKey(match[1]);
    const ownerKey = normalizeOwnerKey(sourceOwnerKey);
    const displayName = decodeHtml(match[2]);
    if (!ownerKey) {
      continue;
    }

    records.push({
      type: "owner",
      sourceId: "mcpservers.org",
      ownerKey,
      sourceOwnerKey,
      displayName,
      skillsCount: parseInteger(match[3]),
      sourceUrl: `${MCPSERVERS_ORIGIN}/agent-skills/author/${sourceOwnerKey}`
    });
  }

  if (!records.length) {
    throw new Error("Could not find mcpservers.org official authors.");
  }

  return records;
}


async function enrichWithGitHubStars(directory) {
  if (!GITHUB_TOKEN) {
    console.warn("GITHUB_TOKEN not set — skipping GitHub stars (set it to fetch stars for all repos)");
    return;
  }

  const repos = directory.officialRepos;
  console.log(`Fetching GitHub stars for ${repos.length} repos (concurrency ${GITHUB_STARS_CONCURRENCY})...`);

  let fetched = 0;
  let failed = 0;
  let rateLimited = false;

  await mapWithConcurrency(repos, GITHUB_STARS_CONCURRENCY, async (repo) => {
    if (rateLimited) {
      return;
    }
    const result = await fetchGitHubRepoStars(repo.repoKey);
    if (result === "rate_limited") {
      rateLimited = true;
      console.warn("GitHub API rate limited — stopping stars enrichment early");
      return;
    }
    if (result && typeof result === "object") {
      repo.starsCount = result.stars;
      repo.canonicalRepoKey = result.canonicalKey;
      fetched++;
    } else {
      failed++;
    }
  });

  console.log(`GitHub stars: ${fetched} fetched, ${failed} failed/not-found`);
}

function aggregateOwnerStars(directory) {
  // Use stars from the best skills repo only (highest installs, then skillsCount).
  // Avoids inflating counts with unrelated OSS repos that happen to have one skill.
  const reposByOwner = new Map();
  for (const repo of directory.officialRepos) {
    const list = reposByOwner.get(repo.ownerKey) || [];
    list.push(repo);
    reposByOwner.set(repo.ownerKey, list);
  }

  for (const owner of directory.officialOwners) {
    const repos = reposByOwner.get(owner.ownerKey) || [];
    const best = repos
      .filter((r) => typeof r.starsCount === "number")
      .sort((a, b) => (b.installsCount || 0) - (a.installsCount || 0) || (b.skillsCount || 0) - (a.skillsCount || 0))[0];
    if (best) {
      owner.starsCount = best.starsCount;
    }
  }
}

async function enrichWithGitHubSkillTrees(directory) {
  if (!GITHUB_TOKEN) {
    console.warn("GITHUB_TOKEN not set — skipping GitHub skill tree verification");
    return;
  }

  const repos = directory.officialRepos;
  console.log(`Fetching GitHub skill trees for ${repos.length} repos (concurrency ${GITHUB_SKILLS_CONCURRENCY})...`);

  let fetched = 0;
  let failed = 0;
  let rateLimited = false;

  await mapWithConcurrency(repos, GITHUB_SKILLS_CONCURRENCY, async (repo) => {
    if (rateLimited) return;
    const result = await fetchGitHubRepoSkillPaths(repo.repoKey);
    if (result === "rate_limited") {
      rateLimited = true;
      console.warn("GitHub API rate limited — stopping skill tree enrichment early");
      return;
    }
    if (result) {
      repo.githubSkillPaths = result.skillPaths; // e.g. ["add-dart-lint", "dart-best-practices"]
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
    "User-Agent": "Skillscout official skills scraper",
    ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {})
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

    // Extract the path-relative skill name from each SKILL.md entry.
    // Handles:  skill-name/SKILL.md       → "skill-name"
    //           cat/skill-name/SKILL.md   → "cat/skill-name"
    //           SKILL.md (root)           → repo name itself
    const skillPaths = [];
    for (const item of data.tree || []) {
      if (item.type !== "blob") continue;
      if (!item.path.endsWith("/SKILL.md") && item.path !== "SKILL.md") continue;

      if (item.path === "SKILL.md") {
        skillPaths.push(normalizeKey(repoKey.split("/")[1]));
      } else {
        // Everything except the trailing /SKILL.md is the skill path
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
  // Map repoKey → Set of confirmed skill paths from GitHub
  const githubByRepo = new Map();
  for (const repo of directory.officialRepos) {
    if (repo.githubSkillPaths) {
      githubByRepo.set(repo.repoKey, new Set(repo.githubSkillPaths));
    }
  }
  if (!githubByRepo.size) return;

  // Build a fast lookup: skillKey → index in officialSkills
  const skillIndex = new Map(directory.officialSkills.map((s, i) => [s.skillKey, i]));

  // Track which skills come from GitHub-verified repos so we can purge ghosts
  const keepSet = new Set();

  for (const [repoKey, githubPaths] of githubByRepo) {
    const repo = directory.officialRepos.find((r) => r.repoKey === repoKey);
    if (!repo) continue;

    const ownerKey = repo.ownerKey;

    // Build install-count lookup for existing catalog skills in this repo
    const catalogInstalls = new Map();
    for (const skill of directory.officialSkills) {
      if (skill.repoKey === repoKey) {
        const slug = normalizeKey(skill.skillName || skill.displayName);
        catalogInstalls.set(slug, Math.max(catalogInstalls.get(slug) || 0, skill.installsCount || 0));
      }
    }

    // Remove all existing catalog-only skills for this repo (will re-add confirmed ones)
    directory.officialSkills = directory.officialSkills.filter((s) => {
      if (s.repoKey !== repoKey) return true;
      // Keep skills already confirmed by github from a previous pass (shouldn't happen, but safe)
      return s.sources.includes("github");
    });

    // Add ground-truth skills from GitHub
    for (const skillPath of githubPaths) {
      const skillName = skillPath.split("/").pop(); // last segment is the human name
      const skillKey = `${repoKey}/${skillPath}`;
      keepSet.add(skillKey);

      const existingIdx = skillIndex.get(skillKey);
      if (existingIdx != null) {
        // Already added (e.g. was confirmed in a previous loop iteration) — add github source
        addUnique(directory.officialSkills[existingIdx].sources, "github");
      } else {
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
          lastSeenAt: generatedAt
        });
      }
    }

    // Update repo skillsCount with the GitHub-verified count
    if (!repo.truncated) {
      repo.skillsCount = githubPaths.size;
    }
  }

  // Re-sort and rebuild stats
  directory.officialSkills.sort((a, b) => a.skillKey.localeCompare(b.skillKey));

  // Recompute owner skillsCount from their actual skills
  const skillCountByOwner = new Map();
  for (const skill of directory.officialSkills) {
    skillCountByOwner.set(skill.ownerKey, (skillCountByOwner.get(skill.ownerKey) || 0) + 1);
  }
  for (const owner of directory.officialOwners) {
    const count = skillCountByOwner.get(owner.ownerKey);
    if (count != null) owner.skillsCount = count;
  }

  directory.stats.skills = directory.officialSkills.length;

  const githubVerifiedRepos = [...githubByRepo.keys()].length;
  const githubVerifiedSkills = directory.officialSkills.filter((s) => s.sources.includes("github")).length;
  console.log(
    `Reconciled: ${githubVerifiedRepos} repos verified, ${githubVerifiedSkills} skills from GitHub`
  );
}

async function fetchGitHubRepoStars(repoKey) {
  const headers = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "Skillscout official skills scraper"
  };
  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }
  try {
    const response = await fetch(`https://api.github.com/repos/${repoKey}`, { headers });
    if (response.status === 404) {
      return null;
    }
    if (response.status === 403 || response.status === 429) {
      return "rate_limited";
    }
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    const stars = data.stargazers_count ?? null;
    if (stars == null) {
      return null;
    }
    // Return canonical name so duplicates (renamed/redirected repos) can be detected
    const canonicalKey = String(data.full_name || repoKey).toLowerCase();
    return { stars, canonicalKey };
  } catch {
    return null;
  }
}

function buildUniversalDirectory(records) {
  const owners = new Map();
  const repos = new Map();
  const skills = new Map();

  for (const record of records) {
    if (record.type === "owner") {
      mergeOwner(owners, record);
    } else if (record.type === "repo") {
      mergeRepo(repos, record);
    } else if (record.type === "skill") {
      mergeSkill(skills, record);
    }
  }

  return {
    schemaVersion: 1,
    generatedAt,
    sources: buildSourceSummary(),
    officialOwners: sortByKey([...owners.values()], "ownerKey"),
    officialRepos: sortByKey([...repos.values()], "repoKey"),
    officialSkills: sortByKey([...skills.values()], "skillKey"),
    stats: {
      owners: owners.size,
      repos: repos.size,
      skills: skills.size,
      sourceOwners: countBySource([...owners.values()]),
      sourceRepos: countBySource([...repos.values()]),
      sourceSkills: countBySource([...skills.values()])
    }
  };
}

function mergeOwner(owners, record) {
  const ownerKey = normalizeOwnerKey(record.ownerKey);
  if (!ownerKey) {
    return;
  }

  const existing = owners.get(ownerKey) || {
    ownerKey,
    displayName: record.displayName || ownerKey,
    normalizedNames: [],
    sourceOwnerKeys: [],
    websiteHosts: [],
    sources: [],
    sourceUrls: [],
    skillsCount: 0,
    reposCount: 0,
    installsCount: 0,
    confidence: "medium",
    firstSeenAt: generatedAt,
    lastSeenAt: generatedAt
  };

  addUnique(existing.normalizedNames, normalizeKey(record.displayName || ownerKey));
  addUnique(existing.sourceOwnerKeys, normalizeKey(record.sourceOwnerKey || record.ownerKey));
  addUnique(existing.sources, record.sourceId);
  addUnique(existing.sourceUrls, record.sourceUrl);
  existing.displayName = chooseDisplayName(existing.displayName, record.displayName || ownerKey);
  existing.skillsCount = Math.max(existing.skillsCount || 0, Number(record.skillsCount || 0));
  existing.reposCount = Math.max(existing.reposCount || 0, Number(record.reposCount || 0));
  existing.installsCount = Math.max(existing.installsCount || 0, Number(record.installsCount || 0));
  existing.confidence = existing.sources.length > 1 ? "high" : "medium";
  owners.set(ownerKey, existing);
}

function mergeRepo(repos, record) {
  const repoKey = normalizeRepoKey(record.repoKey);
  if (!repoKey) {
    return;
  }

  const ownerKey = normalizeOwnerKey(record.ownerKey || repoKey.split("/")[0]);
  const repoName = String(record.repoName || repoKey.split("/").slice(1).join("/")).trim();
  const existing = repos.get(repoKey) || {
    repoKey,
    ownerKey,
    sourceOwnerKeys: [],
    repoName,
    displayName: record.displayName || repoKey,
    sources: [],
    sourceUrls: [],
    skillsCount: 0,
    installsCount: 0,
    confidence: "medium",
    firstSeenAt: generatedAt,
    lastSeenAt: generatedAt
  };

  addUnique(existing.sources, record.sourceId);
  addUnique(existing.sourceUrls, record.sourceUrl);
  addUnique(existing.sourceOwnerKeys, normalizeKey(record.sourceOwnerKey || record.ownerKey || ownerKey));
  existing.displayName = chooseDisplayName(existing.displayName, record.displayName || repoKey);
  existing.skillsCount = Math.max(existing.skillsCount || 0, Number(record.skillsCount || 0));
  existing.installsCount = Math.max(existing.installsCount || 0, Number(record.installsCount || 0));
  existing.confidence = existing.sources.includes("skills.sh") ? "high" : "medium";
  repos.set(repoKey, existing);
}

function mergeSkill(skills, record) {
  const skillKey = String(record.skillKey || "").trim().toLowerCase();
  if (!skillKey) {
    return;
  }

  const existing = skills.get(skillKey) || {
    skillKey,
    ownerKey: normalizeOwnerKey(record.ownerKey),
    sourceOwnerKeys: [],
    repoKey: record.repoKey || "",
    skillName: record.skillName,
    displayName: record.displayName || record.skillName,
    description: record.description || "",
    sources: [],
    sourceUrls: [],
    installsCount: 0,
    confidence: "medium",
    firstSeenAt: generatedAt,
    lastSeenAt: generatedAt
  };

  addUnique(existing.sources, record.sourceId);
  addUnique(existing.sourceUrls, record.sourceUrl);
  addUnique(existing.sourceOwnerKeys, normalizeKey(record.sourceOwnerKey || record.ownerKey));
  if (!existing.description && record.description) {
    existing.description = record.description;
  }
  if (!existing.repoKey && record.repoKey) {
    existing.repoKey = record.repoKey;
  }
  existing.installsCount = Math.max(existing.installsCount || 0, Number(record.installsCount || 0));
  existing.confidence = existing.sources.length > 1 || existing.sources.includes("skills.sh") ? "high" : "medium";
  skills.set(skillKey, existing);
}

function buildSourceSummary() {
  const grouped = {};
  for (const [fetchId, fetchInfo] of Object.entries(sourceFetches)) {
    const sourceId = fetchInfo.sourceId;
    grouped[sourceId] ||= {
      sourceId,
      urls: [],
      fetchedAt: generatedAt,
      status: "ok",
      fetches: []
    };
    grouped[sourceId].urls.push(fetchInfo.url);
    grouped[sourceId].fetches.push({
      fetchId,
      url: fetchInfo.url,
      fetchedAt: fetchInfo.fetchedAt,
      status: fetchInfo.status,
      etag: fetchInfo.etag,
      hash: fetchInfo.hash,
      bytes: fetchInfo.bytes
    });
  }
  return grouped;
}

function extractBalancedJson(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  throw new Error("Could not extract balanced JSON object.");
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
  return results;
}

function buildSkillKey({ ownerKey, repoKey, skillName, sourcePath = "" }) {
  const normalizedSkill = normalizeKey(skillName);
  if (!ownerKey || !normalizedSkill) {
    return "";
  }
  if (repoKey) {
    return `${normalizeRepoKey(repoKey)}/${normalizedSkill}`;
  }
  const pathParts = sourcePath
    .split("/")
    .filter(Boolean)
    .slice(1)
    .map(normalizeKey)
    .filter(Boolean);
  if (pathParts.length) {
    pathParts[0] = normalizeOwnerKey(pathParts[0]);
  }
  const pathKey = pathParts.join("/");
  return pathKey || `${ownerKey}/${normalizedSkill}`;
}

function countSkills(repos = []) {
  return repos.reduce((sum, repo) => sum + Number(repo.skills?.length || 0), 0);
}

function countBySource(records) {
  const counts = {};
  for (const record of records) {
    for (const source of record.sources || []) {
      counts[source] = (counts[source] || 0) + 1;
    }
  }
  return counts;
}

function addUnique(list, value) {
  if (!value || list.includes(value)) {
    return;
  }
  list.push(value);
}

function chooseDisplayName(current, next) {
  const currentValue = String(current || "").trim();
  const nextValue = String(next || "").trim();
  if (!currentValue) {
    return nextValue;
  }
  if (nextValue && nextValue.length < currentValue.length && !nextValue.includes("-")) {
    return nextValue;
  }
  return currentValue;
}

function normalizeRepoKey(value) {
  const parts = String(value || "")
    .trim()
    .toLowerCase()
    .split("/")
    .map(normalizeKey)
    .filter(Boolean);
  if (parts.length >= 2) {
    parts[0] = normalizeOwnerKey(parts[0]);
  }
  return parts.length >= 2 ? parts.join("/") : "";
}

function normalizeOwnerKey(value) {
  const key = normalizeKey(value);
  return OWNER_KEY_ALIASES.get(key) || key;
}

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&amp;/g, "and")
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseInteger(value) {
  return Number(String(value || "").replace(/[^0-9]/g, "")) || 0;
}

function sortByKey(items, key) {
  return items.sort((left, right) => String(left[key]).localeCompare(String(right[key])));
}

function extractFirst(text, regex) {
  return text.match(regex)?.[1] || "";
}

function decodeHtml(value) {
  return String(value || "")
    .replaceAll("<!-- -->", "")
    .replace(/<[^>]*>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/\s+/g, " ")
    .trim();
}

function hashText(text) {
  return `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
}

// ── Preserve github-discovery vendors ────────────────────────────────────────
// Reads the existing JSON (if present) and carries forward discovered
// owners/repos/skills across scheduled scrapes.

async function mergeDiscoveredVendors(directory) {
  let existing;
  try {
    existing = JSON.parse(await fs.readFile(OUTPUT_PATH, "utf8"));
  } catch {
    return;
  }

  const ownersByKey = new Map(directory.officialOwners.map((owner) => [owner.ownerKey, owner]));
  const reposByKey = new Map(directory.officialRepos.map((repo) => [repo.repoKey, repo]));
  const skillsByKey = new Map(directory.officialSkills.map((skill) => [skill.skillKey, skill]));
  const existingOwnersByKey = new Map((existing.officialOwners || []).map((owner) => [owner.ownerKey, owner]));

  const touchedOwnerKeys = new Set();
  const preservedRepoKeys = new Set();
  let addedOwners = 0;
  let mergedOwners = 0;
  let addedRepos = 0;
  let mergedRepos = 0;
  let addedSkills = 0;
  let mergedSkills = 0;

  for (const owner of existing.officialOwners || []) {
    if (!owner.sources?.includes("github-discovery")) continue;
    const current = ownersByKey.get(owner.ownerKey);
    if (current) {
      mergePreservedOwner(current, owner);
      mergedOwners++;
    } else {
      directory.officialOwners.push(owner);
      ownersByKey.set(owner.ownerKey, owner);
      addedOwners++;
    }
    touchedOwnerKeys.add(owner.ownerKey);
  }

  for (const repo of existing.officialRepos || []) {
    if (!repo.sources?.includes("github-discovery")) continue;
    const current = reposByKey.get(repo.repoKey);
    if (current) {
      mergePreservedRepo(current, repo);
      mergedRepos++;
    } else {
      directory.officialRepos.push(repo);
      reposByKey.set(repo.repoKey, repo);
      addedRepos++;
    }
    touchedOwnerKeys.add(repo.ownerKey);
    preservedRepoKeys.add(repo.repoKey);
  }

  for (const skill of existing.officialSkills || []) {
    const existingOwner = existingOwnersByKey.get(skill.ownerKey);
    const fromDiscoveredOwner = existingOwner?.sources?.includes("github-discovery");
    const fromDiscoveredRepo = skill.repoKey && preservedRepoKeys.has(skill.repoKey);
    if (!fromDiscoveredOwner && !fromDiscoveredRepo) continue;

    const current = skillsByKey.get(skill.skillKey);
    if (current) {
      mergePreservedSkill(current, skill);
      mergedSkills++;
    } else {
      directory.officialSkills.push(skill);
      skillsByKey.set(skill.skillKey, skill);
      addedSkills++;
    }
    touchedOwnerKeys.add(skill.ownerKey);
  }

  if (addedOwners || mergedOwners || addedRepos || mergedRepos || addedSkills || mergedSkills) {
    refreshTouchedOwnerCounts(directory, touchedOwnerKeys);
    directory.officialOwners.sort((a, b) => a.ownerKey.localeCompare(b.ownerKey));
    directory.officialRepos.sort((a, b) => a.repoKey.localeCompare(b.repoKey));
    directory.officialSkills.sort((a, b) => a.skillKey.localeCompare(b.skillKey));
    directory.stats = {
      owners: directory.officialOwners.length,
      repos: directory.officialRepos.length,
      skills: directory.officialSkills.length,
      sourceOwners: countBySource(directory.officialOwners),
      sourceRepos: countBySource(directory.officialRepos),
      sourceSkills: countBySource(directory.officialSkills)
    };
    console.log(
      `Preserved from github-discovery: ${addedOwners} owners added, ${mergedOwners} merged; ` +
        `${addedRepos} repos added, ${mergedRepos} merged; ${addedSkills} skills added, ${mergedSkills} merged`
    );
  }
}

function mergePreservedOwner(current, preserved) {
  for (const source of preserved.sources || []) addUnique(current.sources, source);
  for (const url of preserved.sourceUrls || []) addUnique(current.sourceUrls, url);
  for (const name of preserved.normalizedNames || []) addUnique(current.normalizedNames, name);
  for (const key of preserved.sourceOwnerKeys || []) addUnique(current.sourceOwnerKeys, key);
  for (const host of preserved.websiteHosts || []) addUnique(current.websiteHosts, host);
  if (!current.website && preserved.website) current.website = preserved.website;
  current.displayName = chooseDisplayName(current.displayName, preserved.displayName || current.displayName);
  current.reposCount = Math.max(current.reposCount || 0, preserved.reposCount || 0);
  current.skillsCount = Math.max(current.skillsCount || 0, preserved.skillsCount || 0);
  current.installsCount = Math.max(current.installsCount || 0, preserved.installsCount || 0);
  if (typeof preserved.starsCount === "number") {
    current.starsCount = Math.max(current.starsCount || 0, preserved.starsCount);
  }
  current.confidence = current.sources?.length > 1 ? "high" : current.confidence || preserved.confidence || "medium";
  current.firstSeenAt = earliestDate(current.firstSeenAt, preserved.firstSeenAt);
  current.lastSeenAt = generatedAt;
}

function mergePreservedRepo(current, preserved) {
  for (const source of preserved.sources || []) addUnique(current.sources, source);
  for (const url of preserved.sourceUrls || []) addUnique(current.sourceUrls, url);
  for (const key of preserved.sourceOwnerKeys || []) addUnique(current.sourceOwnerKeys, key);
  current.displayName = chooseDisplayName(current.displayName, preserved.displayName || current.displayName);
  current.skillsCount = Math.max(current.skillsCount || 0, preserved.skillsCount || 0);
  current.installsCount = Math.max(current.installsCount || 0, preserved.installsCount || 0);
  if (typeof preserved.starsCount === "number") {
    current.starsCount = Math.max(current.starsCount || 0, preserved.starsCount);
  }
  if (preserved.canonicalRepoKey && !current.canonicalRepoKey) current.canonicalRepoKey = preserved.canonicalRepoKey;
  current.confidence = current.sources?.includes("skills.sh") || current.sources?.includes("github-discovery")
    ? "high"
    : current.confidence || preserved.confidence || "medium";
  current.firstSeenAt = earliestDate(current.firstSeenAt, preserved.firstSeenAt);
  current.lastSeenAt = generatedAt;
}

function mergePreservedSkill(current, preserved) {
  for (const source of preserved.sources || []) addUnique(current.sources, source);
  for (const url of preserved.sourceUrls || []) addUnique(current.sourceUrls, url);
  for (const key of preserved.sourceOwnerKeys || []) addUnique(current.sourceOwnerKeys, key);
  if (!current.description && preserved.description) current.description = preserved.description;
  if (!current.repoKey && preserved.repoKey) current.repoKey = preserved.repoKey;
  current.displayName = chooseDisplayName(current.displayName, preserved.displayName || current.displayName);
  current.installsCount = Math.max(current.installsCount || 0, preserved.installsCount || 0);
  current.confidence = current.sources?.length > 1 || current.sources?.includes("skills.sh")
    ? "high"
    : current.confidence || preserved.confidence || "medium";
  current.firstSeenAt = earliestDate(current.firstSeenAt, preserved.firstSeenAt);
  current.lastSeenAt = generatedAt;
}

function refreshTouchedOwnerCounts(directory, ownerKeys) {
  const repoCountByOwner = new Map();
  for (const repo of directory.officialRepos) {
    if (!ownerKeys.has(repo.ownerKey)) continue;
    repoCountByOwner.set(repo.ownerKey, (repoCountByOwner.get(repo.ownerKey) || 0) + 1);
  }

  const skillCountByOwner = new Map();
  for (const skill of directory.officialSkills) {
    if (!ownerKeys.has(skill.ownerKey)) continue;
    skillCountByOwner.set(skill.ownerKey, (skillCountByOwner.get(skill.ownerKey) || 0) + 1);
  }

  for (const owner of directory.officialOwners) {
    if (!ownerKeys.has(owner.ownerKey)) continue;
    owner.reposCount = repoCountByOwner.get(owner.ownerKey) || owner.reposCount || 0;
    owner.skillsCount = skillCountByOwner.get(owner.ownerKey) || owner.skillsCount || 0;
  }
}

function earliestDate(a, b) {
  if (!a) return b || generatedAt;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}
