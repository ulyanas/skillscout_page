/**
 * Removes SKILL.md records that live inside hidden agent runtime directories.
 *
 * These files configure an agent for a repository (.claude/skills, .agents/skills,
 * .codex/skills, .cursor/skills, .windsurf/skills). Skillscout catalogs vendor
 * distributions, so runtime-local agent skills are excluded from official skills.
 *
 * Run:
 *   node scripts/remove_agent_runtime_skills.mjs
 *
 * Env vars:
 *   OFFICIAL_SKILLS_OUTPUT optional — path to JSON (default: docs/data/official-skills-universal.json)
 *   DRY_RUN                optional — set to 1 to report changes without writing JSON
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAgentRuntimeSkillPath } from "./skill_path_filters.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const DATA_PATH =
  process.env.OFFICIAL_SKILLS_OUTPUT ||
  path.join(root, "docs", "data", "official-skills-universal.json");
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const now = new Date().toISOString();

const directory = JSON.parse(await fs.readFile(DATA_PATH, "utf8"));
const before = countDirectory(directory);
const removedSkills = directory.officialSkills.filter((skill) => isAgentRuntimeSkillPath(skill.skillKey));
const affectedOwnerKeys = new Set(removedSkills.map((skill) => skill.ownerKey).filter(Boolean));
const affectedRepoKeys = new Set(removedSkills.map((skill) => skill.repoKey).filter(Boolean));

directory.officialSkills = directory.officialSkills.filter((skill) => !isAgentRuntimeSkillPath(skill.skillKey));

for (const repo of directory.officialRepos) {
  if (Array.isArray(repo.githubSkillPaths)) {
    repo.githubSkillPaths = repo.githubSkillPaths.filter((skillPath) => !isAgentRuntimeSkillPath(skillPath));
  }
}

const repoKeysWithSkills = new Set(
  directory.officialSkills
    .map((skill) => skill.repoKey)
    .filter(Boolean)
);
directory.officialRepos = directory.officialRepos.filter((repo) => repoKeysWithSkills.has(repo.repoKey));

const ownerKeysWithSkills = new Set(
  directory.officialSkills
    .map((skill) => skill.ownerKey)
    .filter(Boolean)
);
directory.officialOwners = directory.officialOwners.filter((owner) => ownerKeysWithSkills.has(owner.ownerKey));

refreshCounts(directory);
directory.generatedAt = now;
directory.officialOwners.sort((a, b) => a.ownerKey.localeCompare(b.ownerKey));
directory.officialRepos.sort((a, b) => a.repoKey.localeCompare(b.repoKey));
directory.officialSkills.sort((a, b) => a.skillKey.localeCompare(b.skillKey));

const after = countDirectory(directory);
const summary = {
  removedSkills: removedSkills.length,
  removedRepos: before.repos - after.repos,
  removedOwners: before.owners - after.owners,
  affectedOwners: affectedOwnerKeys.size,
  affectedRepos: affectedRepoKeys.size,
  before,
  after,
};

console.log(JSON.stringify(summary, null, 2));

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
