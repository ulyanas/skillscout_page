/**
 * Imports the Skillscout-owned ClawHub listing for Find Official Skills.
 *
 * The same Skillscout skill is published on GitHub/skills.sh and ClawHub.
 * ClawHub exposes public package stats through its search API. Its public
 * skill pages display downloads as the visible popularity count, while this
 * catalog currently has a single installsCount field in the UI.
 *
 * Run:
 *   node scripts/import_skillscout_clawhub_skill.mjs
 *
 * Env vars:
 *   OFFICIAL_SKILLS_OUTPUT optional - path to JSON (default: docs/data/official-skills-universal.json)
 *   DRY_RUN                optional - set to 1 to avoid writing JSON
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const DATA_PATH =
  process.env.OFFICIAL_SKILLS_OUTPUT ||
  path.join(root, "docs", "data", "official-skills-universal.json");
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const SOURCE_ID = "clawhub.ai";
const OWNER_KEY = "skillscout";
const REPO_KEY = "ulyanas/skillscout-skills";
const SKILL_KEY = "ulyanas/skillscout-skills/skills/find-official-skills";
const OWNER_HANDLE = "ulyanas";
const SKILL_NAME = "find-official-skills";
const CLAWHUB_SKILL_URL = `https://clawhub.ai/${OWNER_HANDLE}/skills/${SKILL_NAME}`;
const CLAWHUB_OWNER_URL = `https://clawhub.ai/${OWNER_HANDLE}`;
const CLAWHUB_SEARCH_URL =
  `https://clawhub.ai/api/v1/packages/search?q=${encodeURIComponent(SKILL_NAME)}&family=skill&limit=20`;
const FALLBACK_DESCRIPTION = "Find official, trusted, vendor-owned AI agent skills from Skillscout.";
const now = new Date().toISOString();

const directory = JSON.parse(await fs.readFile(DATA_PATH, "utf8"));
const item = await fetchClawHubSkill();
const stats = item.stats || {};
const downloads = Number(stats.downloads || 0);
const installs = Number(stats.installs || 0);
const visibleCount = Math.max(downloads, installs);

const owner = directory.officialOwners.find((entry) => entry.ownerKey === OWNER_KEY);
const repo = directory.officialRepos.find((entry) => entry.repoKey === REPO_KEY);
const skill = directory.officialSkills.find((entry) => entry.skillKey === SKILL_KEY);

if (!owner || !repo || !skill) {
  throw new Error(`Expected Skillscout entries were not found in ${DATA_PATH}`);
}

mergeOwner(owner, item, downloads, installs);
mergeRepo(repo, item, downloads, installs);
mergeSkill(skill, item, downloads, installs, visibleCount);
upsertSource(item);
refreshCounts();

directory.generatedAt = now;
directory.enrichedAt = now;
directory.officialOwners.sort((a, b) => a.ownerKey.localeCompare(b.ownerKey));
directory.officialRepos.sort((a, b) => a.repoKey.localeCompare(b.repoKey));
directory.officialSkills.sort((a, b) => a.skillKey.localeCompare(b.skillKey));

console.log(
  JSON.stringify(
    {
      source: CLAWHUB_SKILL_URL,
      displayName: item.displayName,
      downloads,
      installs,
      catalogInstallsCount: skill.installsCount
    },
    null,
    2
  )
);

if (!DRY_RUN) {
  await fs.writeFile(DATA_PATH, JSON.stringify(directory, null, 2) + "\n", "utf8");
  console.log(`Wrote ${DATA_PATH}`);
}

async function fetchClawHubSkill() {
  const response = await fetch(CLAWHUB_SEARCH_URL, {
    headers: {
      accept: "application/json",
      "user-agent": "Skillscout ClawHub Skillscout importer"
    }
  });

  if (!response.ok) {
    throw new Error(`ClawHub search failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  const exact = (payload.results || [])
    .map((result) => result.package)
    .find((pkg) => pkg?.ownerHandle === OWNER_HANDLE && pkg?.name === SKILL_NAME);

  if (!exact) {
    throw new Error(`ClawHub package ${OWNER_HANDLE}/${SKILL_NAME} was not found`);
  }

  return exact;
}

function mergeOwner(owner, item, downloads, installs) {
  addUnique(owner.sources, SOURCE_ID);
  addUnique(owner.sourceUrls, CLAWHUB_OWNER_URL);
  addUnique(owner.sourceUrls, CLAWHUB_SKILL_URL);
  addUnique(owner.sourceOwnerKeys, OWNER_HANDLE);
  addUnique(owner.normalizedNames, "skillscout");
  owner.clawhubDownloadsCount = Math.max(Number(owner.clawhubDownloadsCount || 0), downloads);
  owner.clawhubInstallsCount = Math.max(Number(owner.clawhubInstallsCount || 0), installs);
  owner.lastSeenAt = now;

  if (item.summary && !owner.description) {
    owner.description = cleanText(item.summary);
  }
}

function mergeRepo(repo, item, downloads, installs) {
  addUnique(repo.sources, SOURCE_ID);
  addUnique(repo.sourceUrls, CLAWHUB_OWNER_URL);
  addUnique(repo.sourceUrls, CLAWHUB_SKILL_URL);
  addUnique(repo.sourceOwnerKeys, OWNER_HANDLE);
  repo.clawhubDownloadsCount = Math.max(Number(repo.clawhubDownloadsCount || 0), downloads);
  repo.clawhubInstallsCount = Math.max(Number(repo.clawhubInstallsCount || 0), installs);
  repo.lastSeenAt = now;

  if (item.summary && !repo.description) {
    repo.description = cleanText(item.summary);
  }
}

function mergeSkill(skill, item, downloads, installs, visibleCount) {
  addUnique(skill.sources, SOURCE_ID);
  addUnique(skill.sourceUrls, CLAWHUB_SKILL_URL);
  addUnique(skill.sourceOwnerKeys, OWNER_HANDLE);
  skill.displayName = item.displayName || skill.displayName;
  skill.description = chooseDescription(skill.description, item.summary);
  skill.installsCount = Math.max(Number(skill.installsCount || 0), visibleCount);
  skill.downloadsCount = Math.max(Number(skill.downloadsCount || 0), downloads);
  skill.clawhubDownloadsCount = downloads;
  skill.clawhubInstallsCount = installs;
  skill.clawhubOwnerHandle = OWNER_HANDLE;
  skill.clawhubInstallCommand = `openclaw skills install @${OWNER_HANDLE}/${SKILL_NAME}`;
  skill.clawhubUpdatedAt = item.updatedAt ? new Date(item.updatedAt).toISOString() : now;
  skill.confidence = "high";
  skill.official = true;
  skill.lastSeenAt = now;
}

function upsertSource(item) {
  directory.sources ||= {};
  directory.sources[SOURCE_ID] = {
    sourceId: SOURCE_ID,
    urls: ["https://clawhub.ai/official", CLAWHUB_SKILL_URL],
    fetchedAt: now,
    status: "ok",
    note: "Includes a Skillscout-owned ClawHub package override for @ulyanas/find-official-skills.",
    skillscoutPackage: {
      ownerHandle: OWNER_HANDLE,
      name: SKILL_NAME,
      url: CLAWHUB_SKILL_URL,
      downloads: Number(item.stats?.downloads || 0),
      installs: Number(item.stats?.installs || 0)
    }
  };
}

function refreshCounts() {
  const repoSkills = new Map();
  const ownerSkills = new Map();
  const ownerRepos = new Map();
  const repoInstalls = new Map();
  const ownerInstalls = new Map();

  for (const skill of directory.officialSkills) {
    if (!skill.repoKey || !skill.ownerKey) continue;
    repoSkills.set(skill.repoKey, (repoSkills.get(skill.repoKey) || 0) + 1);
    ownerSkills.set(skill.ownerKey, (ownerSkills.get(skill.ownerKey) || 0) + 1);
    repoInstalls.set(skill.repoKey, (repoInstalls.get(skill.repoKey) || 0) + Number(skill.installsCount || 0));
  }

  for (const repo of directory.officialRepos) {
    if (!repo.ownerKey) continue;
    ownerRepos.set(repo.ownerKey, (ownerRepos.get(repo.ownerKey) || 0) + 1);
    repo.skillsCount = repoSkills.get(repo.repoKey) || 0;
    repo.installsCount = Math.max(Number(repo.installsCount || 0), repoInstalls.get(repo.repoKey) || 0);
    ownerInstalls.set(repo.ownerKey, (ownerInstalls.get(repo.ownerKey) || 0) + Number(repo.installsCount || 0));
  }

  for (const owner of directory.officialOwners) {
    owner.skillsCount = ownerSkills.get(owner.ownerKey) || 0;
    owner.reposCount = ownerRepos.get(owner.ownerKey) || 0;
    owner.installsCount = Math.max(Number(owner.installsCount || 0), ownerInstalls.get(owner.ownerKey) || 0);
  }

  directory.stats = {
    owners: directory.officialOwners.length,
    repos: directory.officialRepos.length,
    skills: directory.officialSkills.length,
    sourceOwners: countBySource(directory.officialOwners),
    sourceRepos: countBySource(directory.officialRepos),
    sourceSkills: countBySource(directory.officialSkills)
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

function addUnique(list, value) {
  if (!value) return;
  if (!Array.isArray(list)) return;
  if (!list.includes(value)) list.push(value);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function chooseDescription(current, candidate) {
  const cleanCurrent = cleanText(current);
  const cleanCandidate = cleanText(candidate);
  if (cleanCandidate && !cleanCandidate.endsWith("...")) return cleanCandidate;
  if (cleanCurrent && !cleanCurrent.endsWith("...")) return cleanCurrent;
  return FALLBACK_DESCRIPTION;
}
