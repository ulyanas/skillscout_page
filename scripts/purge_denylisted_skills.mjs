/**
 * Removes denylisted owners, repos, and skills from the official directory.
 *
 * The denylist lives in scripts/catalog_denylist.mjs. Run this after adding an
 * entry there, then rebuild the pages so the generated vendor pages and
 * manifests drop the removed records too.
 *
 * Run:
 *   node scripts/purge_denylisted_skills.mjs
 *
 * Env vars:
 *   OFFICIAL_SKILLS_OUTPUT optional — path to JSON (default: docs/data/official-skills-universal.json)
 *   DRY_RUN                optional — set to 1 to report changes without writing JSON
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeniedOwnerKey, isDeniedRepoKey, isDeniedSkillKey } from "./catalog_denylist.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const DATA_PATH =
  process.env.OFFICIAL_SKILLS_OUTPUT ||
  path.join(root, "docs", "data", "official-skills-universal.json");
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const now = new Date().toISOString();

const directory = JSON.parse(await fs.readFile(DATA_PATH, "utf8"));
const before = countDirectory(directory);

const removedSkills = directory.officialSkills.filter((skill) => isDeniedSkillKey(skill.skillKey));
const removedRepos = directory.officialRepos.filter((repo) => isDeniedRepoKey(repo.repoKey));
const removedOwners = directory.officialOwners.filter((owner) => isDeniedOwnerKey(owner.ownerKey));

directory.officialSkills = directory.officialSkills.filter((skill) => !isDeniedSkillKey(skill.skillKey));
directory.officialRepos = directory.officialRepos.filter((repo) => !isDeniedRepoKey(repo.repoKey));
directory.officialOwners = directory.officialOwners.filter((owner) => !isDeniedOwnerKey(owner.ownerKey));

refreshCounts(directory);
directory.generatedAt = now;

const after = countDirectory(directory);
console.log(
  JSON.stringify(
    {
      removedSkills: removedSkills.map((skill) => skill.skillKey),
      removedRepos: removedRepos.map((repo) => repo.repoKey),
      removedOwners: removedOwners.map((owner) => owner.ownerKey),
      before,
      after,
    },
    null,
    2
  )
);

if (DRY_RUN) {
  console.log("DRY_RUN=1 — no file changes written");
} else {
  await fs.writeFile(DATA_PATH, `${JSON.stringify(directory, null, 2)}\n`);
  console.log(`Wrote ${DATA_PATH}`);
}

function refreshCounts(directory) {
  const repoCountByOwner = new Map();
  const skillCountByOwner = new Map();
  const starsByOwner = new Map();

  for (const repo of directory.officialRepos) {
    repoCountByOwner.set(repo.ownerKey, (repoCountByOwner.get(repo.ownerKey) || 0) + 1);
    starsByOwner.set(repo.ownerKey, (starsByOwner.get(repo.ownerKey) || 0) + Number(repo.starsCount || 0));
  }

  for (const skill of directory.officialSkills) {
    skillCountByOwner.set(skill.ownerKey, (skillCountByOwner.get(skill.ownerKey) || 0) + 1);
  }

  for (const repo of directory.officialRepos) {
    repo.skillsCount = Number(skillCountByRepo(directory, repo.repoKey));
  }

  for (const owner of directory.officialOwners) {
    owner.reposCount = repoCountByOwner.get(owner.ownerKey) || 0;
    owner.skillsCount = skillCountByOwner.get(owner.ownerKey) || 0;
    owner.starsCount = starsByOwner.get(owner.ownerKey) || 0;
  }

  directory.stats = {
    owners: directory.officialOwners.length,
    repos: directory.officialRepos.length,
    skills: directory.officialSkills.length,
    sourceOwners: countBySource(directory.officialOwners),
    sourceRepos: countBySource(directory.officialRepos),
    sourceSkills: countBySource(directory.officialSkills),
  };
}

function skillCountByRepo(directory, repoKey) {
  let count = 0;
  for (const skill of directory.officialSkills) {
    if (skill.repoKey === repoKey) count++;
  }
  return count;
}

function countDirectory(directory) {
  return {
    owners: directory.officialOwners.length,
    repos: directory.officialRepos.length,
    skills: directory.officialSkills.length,
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
