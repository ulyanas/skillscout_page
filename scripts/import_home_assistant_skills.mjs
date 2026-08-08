/**
 * Imports official Home Assistant skills from GitHub.
 *
 * Home Assistant publishes first-party skills inside agent runtime directories
 * (`.claude/skills` and `.agents/skills`). Those directories are normally
 * excluded from broad discovery, so this script treats Home Assistant as an
 * explicit official exception.
 *
 * Run:
 *   node scripts/import_home_assistant_skills.mjs
 *
 * Env vars:
 *   OFFICIAL_SKILLS_OUTPUT optional — path to JSON (default: docs/data/official-skills-universal.json)
 *   DRY_RUN                optional — set to 1 to avoid writing JSON
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { shouldCatalogSkillFilePath } from "./skill_path_filters.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const DATA_PATH =
  process.env.OFFICIAL_SKILLS_OUTPUT ||
  path.join(root, "docs", "data", "official-skills-universal.json");
const SOURCE_ID = "github-agent-runtime-exception";
const OWNER_KEY = "home-assistant";
const OWNER_DISPLAY_NAME = "Home Assistant";
const OWNER_WEBSITE = "https://www.home-assistant.io";
const OWNER_GITHUB_URL = "https://github.com/home-assistant";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const now = new Date().toISOString();

const REPO_ALLOWLIST = new Set([
  "home-assistant/android",
  "home-assistant/core",
  "home-assistant/frontend",
  "home-assistant/home-assistant.io",
  "home-assistant/iOS"
]);

const directory = JSON.parse(await fs.readFile(DATA_PATH, "utf8"));
const ownersByKey = new Map(directory.officialOwners.map((owner) => [owner.ownerKey, owner]));
const reposByKey = new Map(directory.officialRepos.map((repo) => [repo.repoKey, repo]));
const skillsByKey = new Map(directory.officialSkills.map((skill) => [skill.skillKey, skill]));
const org = ghApi("/orgs/home-assistant");
const repos = [];
const hadOwner = ownersByKey.has(OWNER_KEY);

for (const fullName of [...REPO_ALLOWLIST].sort((a, b) => a.localeCompare(b))) {
  repos.push(ghApi(`/repos/${fullName}`));
}

const owner = upsertOwner(org);
const stats = {
  addedOwners: hadOwner ? 0 : 1,
  addedRepos: 0,
  mergedRepos: 0,
  addedSkills: 0,
  mergedSkills: 0,
  skippedPaths: 0
};

for (const repo of repos) {
  const skillFiles = await findSkillFiles(repo);
  if (!skillFiles.length) continue;

  const repoEntry = upsertRepo(owner, repo, skillFiles);
  for (const skillFile of skillFiles) {
    const markdown = await fetchRaw(repo.full_name, repo.default_branch, `${skillFile}/SKILL.md`);
    const metadata = parseSkillMarkdown(markdown, skillFile);
    upsertSkill(owner, repoEntry, repo, skillFile, metadata);
  }
}

refreshCounts();
upsertSource();
directory.generatedAt = now;
directory.enrichedAt = now;
directory.officialOwners.sort((a, b) => a.ownerKey.localeCompare(b.ownerKey));
directory.officialRepos.sort((a, b) => a.repoKey.localeCompare(b.repoKey));
directory.officialSkills.sort((a, b) => a.skillKey.localeCompare(b.skillKey));

console.log(JSON.stringify(stats, null, 2));
console.log(
  `Home Assistant: ${owner.skillsCount || 0} skills across ${owner.reposCount || 0} repos`
);

if (!DRY_RUN) {
  await fs.writeFile(DATA_PATH, JSON.stringify(directory, null, 2) + "\n", "utf8");
  console.log(`Wrote ${DATA_PATH}`);
}

async function findSkillFiles(repo) {
  const tree = ghApi(`/repos/${repo.full_name}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`);
  const paths = (tree.tree || [])
    .filter((node) => node.type === "blob")
    .map((node) => node.path)
    .filter((filePath) => /(?:^|\/)\.(?:agents|claude)\/skills\/[^/]+\/SKILL\.md$/i.test(filePath))
    .map((filePath) => filePath.replace(/\/SKILL\.md$/i, ""))
    .filter((skillPath) => {
      const catalogPath = `${normalizeRepoKey(repo.full_name)}/${skillPath}`;
      const keep = shouldCatalogSkillFilePath(catalogPath);
      if (!keep) stats.skippedPaths += 1;
      return keep;
    })
    .sort((a, b) => a.localeCompare(b));

  return [...new Set(paths)];
}

function upsertOwner(org) {
  const existing = ownersByKey.get(OWNER_KEY);
  const owner = existing || {
    ownerKey: OWNER_KEY,
    displayName: OWNER_DISPLAY_NAME,
    normalizedNames: [],
    sourceOwnerKeys: [],
    websiteHosts: [],
    sources: [],
    sourceUrls: [],
    skillsCount: 0,
    reposCount: 0,
    installsCount: 0,
    starsCount: 0,
    confidence: "high"
  };

  owner.displayName = OWNER_DISPLAY_NAME;
  owner.description = org.description || owner.description || "";
  owner.website = OWNER_WEBSITE;
  owner.websiteUrl = OWNER_WEBSITE;
  owner.githubLogin = org.login || "home-assistant";
  owner.githubUrl = org.html_url || OWNER_GITHUB_URL;
  owner.orgType = "Organization";
  owner.githubVerified = Boolean(org.is_verified ?? true);
  owner.official = true;
  owner.confidence = "high";
  owner.avatarUrl = org.avatar_url || owner.avatarUrl || "";
  owner.logoUrl = org.avatar_url || owner.logoUrl || owner.avatarUrl || "";
  owner.lastSeenAt = now;
  owner.firstSeenAt ||= now;

  addUnique(owner.normalizedNames, OWNER_KEY);
  addUnique(owner.normalizedNames, "home assistant");
  addUnique(owner.sourceOwnerKeys, "home-assistant");
  addUnique(owner.websiteHosts, "home-assistant.io");
  addUnique(owner.sources, "github-discovery");
  addUnique(owner.sources, SOURCE_ID);
  addUnique(owner.sourceUrls, OWNER_GITHUB_URL);
  addUnique(owner.sourceUrls, OWNER_WEBSITE);

  if (!existing) {
    directory.officialOwners.push(owner);
    ownersByKey.set(OWNER_KEY, owner);
  }

  return owner;
}

function upsertRepo(owner, repo, skillFiles) {
  const repoKey = normalizeRepoKey(repo.full_name);
  let entry = reposByKey.get(repoKey);

  if (!entry) {
    entry = {
      repoKey,
      ownerKey: owner.ownerKey,
      repoName: repoKey.split("/").pop(),
      displayName: repo.full_name,
      sourceOwnerKeys: ["home-assistant"],
      sources: [],
      sourceUrls: [],
      skillsCount: 0,
      installsCount: 0,
      starsCount: 0,
      confidence: "high",
      firstSeenAt: now
    };
    directory.officialRepos.push(entry);
    reposByKey.set(repoKey, entry);
    stats.addedRepos += 1;
  } else {
    stats.mergedRepos += 1;
  }

  entry.ownerKey = owner.ownerKey;
  entry.displayName = repo.full_name;
  entry.description = repo.description || entry.description || "";
  entry.canonicalRepoKey = repo.full_name;
  entry.githubDefaultBranch = repo.default_branch;
  entry.githubSkillPaths = skillFiles;
  entry.githubSkillPathsFetchedAt = now;
  entry.githubVerified = true;
  entry.official = true;
  entry.confidence = "high";
  entry.starsCount = Math.max(Number(entry.starsCount || 0), Number(repo.stargazers_count || 0));
  entry.installCommand = `npx skills add ${repo.full_name} --full-depth -y`;
  entry.installCommandTemplate = `npx skills add ${repo.full_name} --skill {skillName} --full-depth -y`;
  entry.sourceKind = "github-full-depth";
  entry.lastSeenAt = now;

  addUnique(entry.sources, "github-discovery");
  addUnique(entry.sources, SOURCE_ID);
  addUnique(entry.sourceUrls, repo.html_url || `https://github.com/${repo.full_name}`);

  return entry;
}

function upsertSkill(owner, repoEntry, repo, skillPath, metadata) {
  const skillName = normalizeKey(metadata.name || skillPath.split("/").at(-1));
  const skillKey = `${repoEntry.repoKey}/${skillPath}`;
  const sourceUrl = `${repo.html_url}/tree/${repo.default_branch}/${skillPath}`;
  let skill = skillsByKey.get(skillKey);

  if (!skill) {
    skill = {
      skillKey,
      ownerKey: owner.ownerKey,
      repoKey: repoEntry.repoKey,
      skillName,
      displayName: metadata.name || prettifyName(skillName),
      description: metadata.description || "",
      sources: [],
      sourceUrls: [],
      installsCount: 0,
      confidence: "high",
      firstSeenAt: now
    };
    directory.officialSkills.push(skill);
    skillsByKey.set(skillKey, skill);
    stats.addedSkills += 1;
  } else {
    stats.mergedSkills += 1;
  }

  skill.ownerKey = owner.ownerKey;
  skill.repoKey = repoEntry.repoKey;
  skill.skillName = skillName;
  skill.displayName = metadata.name || skill.displayName || prettifyName(skillName);
  skill.description = metadata.description || skill.description || "";
  skill.sourcePath = `${skillPath}/SKILL.md`;
  skill.installCommand = `npx skills add ${repo.full_name} --skill ${skillName} --full-depth -y`;
  skill.githubVerified = true;
  skill.official = true;
  skill.confidence = "high";
  skill.lastSeenAt = now;

  addUnique(skill.sources, "github");
  addUnique(skill.sources, SOURCE_ID);
  addUnique(skill.sourceUrls, sourceUrl);
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

function upsertSource() {
  directory.sources ||= {};
  directory.sources[SOURCE_ID] = {
    sourceId: SOURCE_ID,
    urls: [OWNER_GITHUB_URL],
    fetchedAt: now,
    status: "ok",
    note: "Home Assistant first-party exception for skills published under .claude/skills and .agents/skills."
  };
}

function ghApi(endpoint) {
  return JSON.parse(
    execFileSync("gh", ["api", endpoint], {
      encoding: "utf8",
      maxBuffer: 100 * 1024 * 1024
    })
  );
}

async function fetchRaw(repoFullName, ref, filePath) {
  const url = `https://raw.githubusercontent.com/${repoFullName}/${encodeURIComponent(ref)}/${filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const response = await fetch(url, {
    headers: {
      accept: "text/plain",
      "user-agent": "Skillscout Home Assistant importer"
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function parseSkillMarkdown(markdown, skillPath) {
  const fallbackName = skillPath.split("/").at(-1);
  const frontmatterMatch = String(markdown || "").match(/^---\n([\s\S]*?)\n---/);
  const frontmatter = frontmatterMatch?.[1] || "";
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") || fallbackName;
  const description =
    frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") ||
    firstParagraph(markdown);
  return {
    name,
    description
  };
}

function firstParagraph(markdown) {
  return String(markdown || "")
    .replace(/^---[\s\S]*?---/, "")
    .split(/\n{2,}/)
    .map((part) => part.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim())
    .find(Boolean) || "";
}

function normalizeRepoKey(value) {
  const [owner = "", repo = ""] = String(value || "").split("/");
  return `${normalizeKey(owner)}/${normalizeKey(repo)}`;
}

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&amp;/g, "and")
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function prettifyName(value) {
  return String(value || "")
    .split(/[-_\s./]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function addUnique(list, value) {
  if (!value) return;
  if (!Array.isArray(list)) return;
  if (!list.includes(value)) list.push(value);
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
