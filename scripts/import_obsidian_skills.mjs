/**
 * Imports official Obsidian skills from kepano/obsidian-skills.
 *
 * The skills are published in Steph Ango's repository, but the vendor owner
 * in Skillscout is Obsidian because the package is for Obsidian and is linked
 * to the official Obsidian website.
 *
 * Run:
 *   node scripts/import_obsidian_skills.mjs
 *
 * Env vars:
 *   OFFICIAL_SKILLS_OUTPUT optional - path to JSON (default: docs/data/official-skills-universal.json)
 *   GITHUB_TOKEN           optional - increases GitHub API limits
 *   DRY_RUN                optional - set to 1 to avoid writing JSON
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decodeEmojiShortcodes, normalizeEmojiShortcodesInDirectory } from "./emoji_shortcodes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const DATA_PATH =
  process.env.OFFICIAL_SKILLS_OUTPUT ||
  path.join(root, "docs", "data", "official-skills-universal.json");
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const SOURCE_ID = "github-official-exception";
const OWNER_KEY = "obsidian";
const OWNER_DISPLAY_NAME = "Obsidian";
const OWNER_WEBSITE = "https://obsidian.md/";
const OWNER_GITHUB_URL = "https://github.com/obsidian";
const OWNER_LOGO_URL = "https://obsidian.md/images/obsidian-logo-gradient.svg";
const REPO_FULL_NAME = "kepano/obsidian-skills";
const REPO_URL = `https://github.com/${REPO_FULL_NAME}`;
const INSTALL_REPO = `https://github.com/${REPO_FULL_NAME}`;
const now = new Date().toISOString();

const directory = JSON.parse(await fs.readFile(DATA_PATH, "utf8"));
const ownersByKey = new Map(directory.officialOwners.map((owner) => [owner.ownerKey, owner]));
const reposByKey = new Map(directory.officialRepos.map((repo) => [repo.repoKey, repo]));
const skillsByKey = new Map(directory.officialSkills.map((skill) => [skill.skillKey, skill]));
const hadOwner = ownersByKey.has(OWNER_KEY);
const hadRepo = reposByKey.has(normalizeRepoKey(REPO_FULL_NAME));
const repo = await githubApi(`/repos/${REPO_FULL_NAME}`);
const skillFiles = await findSkillFiles(repo);
const owner = upsertOwner();
const repoEntry = upsertRepo(owner, repo, skillFiles);
const stats = {
  addedOwners: hadOwner ? 0 : 1,
  addedRepos: hadRepo ? 0 : 1,
  mergedRepos: hadRepo ? 1 : 0,
  addedSkills: 0,
  mergedSkills: 0
};

for (const skillPath of skillFiles) {
  const markdown = await fetchRaw(repo.full_name, repo.default_branch, `${skillPath}/SKILL.md`);
  const metadata = parseSkillMarkdown(markdown, skillPath);
  upsertSkill(owner, repoEntry, repo, skillPath, metadata);
}

refreshCounts();
upsertSource(repo, skillFiles);
normalizeEmojiShortcodesInDirectory(directory);
directory.generatedAt = now;
directory.enrichedAt = now;
directory.officialOwners.sort((a, b) => a.ownerKey.localeCompare(b.ownerKey));
directory.officialRepos.sort((a, b) => a.repoKey.localeCompare(b.repoKey));
directory.officialSkills.sort((a, b) => a.skillKey.localeCompare(b.skillKey));

console.log(JSON.stringify(stats, null, 2));
console.log(`Obsidian: ${owner.skillsCount || 0} skills across ${owner.reposCount || 0} repo`);

if (!DRY_RUN) {
  await fs.writeFile(DATA_PATH, JSON.stringify(directory, null, 2) + "\n", "utf8");
  console.log(`Wrote ${DATA_PATH}`);
}

async function findSkillFiles(repo) {
  const tree = await githubApi(
    `/repos/${repo.full_name}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`
  );
  return [...new Set((tree.tree || [])
    .filter((node) => node.type === "blob")
    .map((node) => node.path)
    .filter((filePath) => /^skills\/[^/]+\/SKILL\.md$/i.test(filePath))
    .map((filePath) => filePath.replace(/\/SKILL\.md$/i, "")))]
    .sort((a, b) => a.localeCompare(b));
}

function upsertOwner() {
  let owner = ownersByKey.get(OWNER_KEY);
  if (!owner) {
    owner = {
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
      confidence: "high",
      firstSeenAt: now
    };
    directory.officialOwners.push(owner);
    ownersByKey.set(OWNER_KEY, owner);
  }

  owner.displayName = OWNER_DISPLAY_NAME;
  owner.description = "Obsidian is a private and flexible writing app for notes, knowledge bases, and Markdown-first workflows.";
  owner.website = OWNER_WEBSITE;
  owner.websiteUrl = OWNER_WEBSITE;
  owner.githubLogin = "obsidian";
  owner.githubUrl = OWNER_GITHUB_URL;
  owner.orgType = "Organization";
  owner.official = true;
  owner.confidence = "high";
  owner.avatarUrl = OWNER_LOGO_URL;
  owner.logoUrl = OWNER_LOGO_URL;
  owner.lastSeenAt = now;
  owner.firstSeenAt ||= now;

  addUnique(owner.normalizedNames, "obsidian");
  addUnique(owner.normalizedNames, "obsidian md");
  addUnique(owner.sourceOwnerKeys, OWNER_KEY);
  addUnique(owner.websiteHosts, "obsidian.md");
  addUnique(owner.sources, "github-discovery");
  addUnique(owner.sources, SOURCE_ID);
  addUnique(owner.sourceUrls, OWNER_WEBSITE);
  addUnique(owner.sourceUrls, OWNER_GITHUB_URL);

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
      displayName: "Obsidian Skills",
      sourceOwnerKeys: [],
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
  }

  entry.ownerKey = owner.ownerKey;
  entry.displayName = "Obsidian Skills";
  entry.description = decodeEmojiShortcodes(repo.description || entry.description || "");
  entry.canonicalRepoKey = repo.full_name;
  entry.githubDefaultBranch = repo.default_branch;
  entry.githubSkillPaths = skillFiles;
  entry.githubSkillPathsFetchedAt = now;
  entry.githubVerified = true;
  entry.official = true;
  entry.confidence = "high";
  entry.starsCount = Math.max(Number(entry.starsCount || 0), Number(repo.stargazers_count || 0));
  entry.installCommand = `npx skills add ${INSTALL_REPO} -y`;
  entry.installCommandTemplate = `npx skills add ${INSTALL_REPO} --skill {skillName} -y`;
  entry.sourceKind = "github";
  entry.lastSeenAt = now;

  addUnique(entry.sourceOwnerKeys, "kepano");
  addUnique(entry.sources, "github-discovery");
  addUnique(entry.sources, SOURCE_ID);
  addUnique(entry.sourceUrls, repo.html_url || REPO_URL);
  addUnique(entry.sourceUrls, OWNER_WEBSITE);

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
  skill.description = decodeEmojiShortcodes(metadata.description || skill.description || "");
  skill.sourcePath = `${skillPath}/SKILL.md`;
  skill.installCommand = `npx skills add ${INSTALL_REPO} --skill ${skillName} -y`;
  skill.githubVerified = true;
  skill.official = true;
  skill.confidence = "high";
  skill.lastSeenAt = now;

  addUnique(skill.sourceOwnerKeys, "kepano");
  addUnique(skill.sources, "github");
  addUnique(skill.sources, SOURCE_ID);
  addUnique(skill.sourceUrls, sourceUrl);
  addUnique(skill.sourceUrls, OWNER_WEBSITE);
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

function upsertSource(repo, skillFiles) {
  directory.sources ||= {};
  directory.sources[SOURCE_ID] = {
    sourceId: SOURCE_ID,
    urls: [REPO_URL, OWNER_WEBSITE],
    fetchedAt: now,
    status: "ok",
    note: "Obsidian official exception for skills published in kepano/obsidian-skills.",
    repo: repo.full_name,
    skillPaths: skillFiles
  };
}

async function githubApi(endpoint) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    headers: githubHeaders()
  });
  if (!response.ok) {
    throw new Error(`GitHub API failed for ${endpoint}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchRaw(repoFullName, ref, filePath) {
  const url = `https://raw.githubusercontent.com/${repoFullName}/${encodeURIComponent(ref)}/${filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const response = await fetch(url, {
    headers: {
      accept: "text/plain",
      "user-agent": "Skillscout Obsidian importer"
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function githubHeaders() {
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "Skillscout Obsidian importer"
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

function parseSkillMarkdown(markdown, skillPath) {
  const fallbackName = skillPath.split("/").at(-1);
  const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---/);
  const metadata = {
    name: fallbackName,
    description: ""
  };
  if (!frontmatter) return metadata;

  const yaml = frontmatter[1];
  for (const field of ["name", "description"]) {
    const match = yaml.match(new RegExp(`^${field}:\\s*(.*)$`, "m"));
    if (!match) continue;
    metadata[field] = unquoteYamlScalar(match[1]);
  }
  return metadata;
}

function unquoteYamlScalar(value) {
  const trimmed = String(value || "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function countBySource(items) {
  const counts = {};
  for (const item of items || []) {
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

function normalizeRepoKey(value) {
  return String(value || "").trim().toLowerCase();
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
