/**
 * Imports official Doist skills from verified Doist GitHub repositories.
 *
 * Only top-level skills/<name>/SKILL.md entries are imported. Runtime helper skills
 * under .agents or .claude are skipped.
 *
 * Run:
 *   GITHUB_TOKEN=$(gh auth token) node scripts/import_doist_skills.mjs
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
const SOURCE_ID = "github-doist-official";
const OWNER_KEY = "doist";
const OWNER_LOGIN = "Doist";
const OWNER_DISPLAY_NAME = "Doist";
const OWNER_WEBSITE = "https://doist.com/";
const TODOIST_WEBSITE = "https://todoist.com/";
const GITHUB_ORG_URL = "https://github.com/Doist";
const SKILLS_SH_ORIGIN = "https://www.skills.sh";
const SKILLS_SH_FETCH_TIMEOUT_MS = Number(process.env.SKILLS_SH_FETCH_TIMEOUT_MS || 10000);
const now = new Date().toISOString();

const directory = JSON.parse(await fs.readFile(DATA_PATH, "utf8"));
const ownersByKey = new Map(directory.officialOwners.map((owner) => [owner.ownerKey, owner]));
const reposByKey = new Map(directory.officialRepos.map((repo) => [repo.repoKey, repo]));
const skillsByKey = new Map(directory.officialSkills.map((skill) => [skill.skillKey, skill]));
const hadOwner = ownersByKey.has(OWNER_KEY);
const ownerInfo = await githubApi(`/orgs/${OWNER_LOGIN}`);
const repoInfos = await listOrgRepos(OWNER_LOGIN);
const reposWithSkills = [];
const stats = {
  addedOwners: hadOwner ? 0 : 1,
  addedRepos: 0,
  mergedRepos: 0,
  addedSkills: 0,
  mergedSkills: 0,
  skippedRuntimeSkills: 0,
  skillsShInstallsUpdated: 0
};

for (const repo of repoInfos) {
  const skillPaths = await findOfficialSkillPaths(repo);
  if (!skillPaths.length) continue;
  reposWithSkills.push({ repo, skillPaths });
}

const owner = upsertOwner(ownerInfo);
for (const { repo, skillPaths } of reposWithSkills) {
  const repoEntry = upsertRepo(owner, repo, skillPaths);
  for (const skillPath of skillPaths) {
    const markdown = await fetchRaw(repo.full_name, repo.default_branch, `${skillPath}/SKILL.md`);
    const metadata = parseSkillMarkdown(markdown, skillPath);
    upsertSkill(owner, repoEntry, repo, skillPath, metadata);
  }
  await enrichRepoWithSkillsShInstalls(repoEntry);
}

refreshCounts();
upsertSource(reposWithSkills);
normalizeEmojiShortcodesInDirectory(directory);
directory.generatedAt = now;
directory.enrichedAt = now;
directory.officialOwners.sort((a, b) => a.ownerKey.localeCompare(b.ownerKey));
directory.officialRepos.sort((a, b) => a.repoKey.localeCompare(b.repoKey));
directory.officialSkills.sort((a, b) => a.skillKey.localeCompare(b.skillKey));

console.log(JSON.stringify(stats, null, 2));
console.log(`Doist: ${owner.skillsCount || 0} skills across ${owner.reposCount || 0} repos`);

if (!DRY_RUN) {
  await fs.writeFile(DATA_PATH, JSON.stringify(directory, null, 2) + "\n", "utf8");
  console.log(`Wrote ${DATA_PATH}`);
}

async function listOrgRepos(login) {
  const repos = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await githubApi(`/orgs/${login}/repos?per_page=100&page=${page}&type=public`);
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos.sort((a, b) => a.full_name.localeCompare(b.full_name));
}

async function findOfficialSkillPaths(repo) {
  const tree = await githubApi(
    `/repos/${repo.full_name}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`
  );
  const paths = [];
  for (const node of tree.tree || []) {
    if (node.type !== "blob") continue;
    const filePath = node.path;
    if (/^(\.agents|\.claude)\//i.test(filePath)) {
      if (/SKILL\.md$/i.test(filePath)) stats.skippedRuntimeSkills += 1;
      continue;
    }
    if (!/^skills\/[^/]+\/SKILL\.md$/i.test(filePath)) continue;
    paths.push(filePath.replace(/\/SKILL\.md$/i, ""));
  }
  return [...new Set(paths)].sort((a, b) => a.localeCompare(b));
}

function upsertOwner(info) {
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
  owner.companyName = OWNER_DISPLAY_NAME;
  owner.description = decodeEmojiShortcodes(
    info.description || "Doist builds Todoist and Twist for focused productivity and team communication."
  );
  owner.website = OWNER_WEBSITE;
  owner.websiteUrl = OWNER_WEBSITE;
  owner.githubLogin = OWNER_LOGIN;
  owner.githubUrl = GITHUB_ORG_URL;
  owner.orgType = "Organization";
  owner.githubVerified = Boolean(info.is_verified) || owner.githubVerified === true;
  owner.official = true;
  owner.confidence = "high";
  owner.avatarUrl = info.avatar_url || owner.avatarUrl;
  owner.logoUrl = info.avatar_url || owner.logoUrl;
  owner.lastSeenAt = now;
  owner.firstSeenAt ||= now;

  addUnique(owner.normalizedNames, "doist");
  addUnique(owner.normalizedNames, "todoist");
  addUnique(owner.sourceOwnerKeys, OWNER_LOGIN);
  addUnique(owner.websiteHosts, "doist.com");
  addUnique(owner.websiteHosts, "todoist.com");
  addUnique(owner.sources, "github-discovery");
  addUnique(owner.sources, SOURCE_ID);
  addUnique(owner.sourceUrls, GITHUB_ORG_URL);
  addUnique(owner.sourceUrls, OWNER_WEBSITE);
  addUnique(owner.sourceUrls, TODOIST_WEBSITE);

  return owner;
}

function upsertRepo(owner, repo, skillPaths) {
  const repoKey = normalizeRepoKey(repo.full_name);
  let entry = reposByKey.get(repoKey);
  if (!entry) {
    entry = {
      repoKey,
      ownerKey: owner.ownerKey,
      repoName: repo.name,
      displayName: repo.full_name,
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
    stats.addedRepos += 1;
  } else {
    stats.mergedRepos += 1;
  }

  entry.ownerKey = owner.ownerKey;
  entry.repoName = repo.name;
  entry.displayName = repo.full_name;
  entry.description = decodeEmojiShortcodes(repo.description || entry.description || "");
  entry.canonicalRepoKey = repo.full_name;
  entry.githubDefaultBranch = repo.default_branch;
  entry.githubSkillPaths = skillPaths;
  entry.githubSkillPathsFetchedAt = now;
  entry.githubVerified = true;
  entry.official = true;
  entry.confidence = "high";
  entry.starsCount = Math.max(Number(entry.starsCount || 0), Number(repo.stargazers_count || 0));
  entry.installCommand = `npx skills add https://github.com/${repo.full_name} -y`;
  entry.installCommandTemplate = `npx skills add https://github.com/${repo.full_name} --skill {skillName} -y`;
  entry.sourceKind = "github";
  entry.lastSeenAt = now;

  addUnique(entry.sourceOwnerKeys, OWNER_LOGIN);
  addUnique(entry.sources, "github-discovery");
  addUnique(entry.sources, SOURCE_ID);
  addUnique(entry.sourceUrls, repo.html_url);

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
  skill.installCommand = `npx skills add https://github.com/${repo.full_name} --skill ${skillName} -y`;
  skill.githubVerified = true;
  skill.official = true;
  skill.confidence = "high";
  skill.lastSeenAt = now;

  addUnique(skill.sourceOwnerKeys, OWNER_LOGIN);
  addUnique(skill.sources, "github");
  addUnique(skill.sources, SOURCE_ID);
  addUnique(skill.sourceUrls, sourceUrl);
}

async function enrichRepoWithSkillsShInstalls(repoEntry) {
  const repoUrl = `${SKILLS_SH_ORIGIN}/${repoEntry.repoKey}`;
  try {
    const html = await fetchSkillsShHtml(repoUrl);
    const records = await fetchSkillsShInstallRecords(html, repoEntry.repoKey);
    if (!records.length) return;

    let updated = 0;
    for (const record of records) {
      const skill = findRepoSkill(repoEntry.repoKey, record.slug || record.name);
      if (!skill) continue;
      skill.installsCount = Math.max(Number(skill.installsCount || 0), Number(record.installs || 0));
      addUnique(skill.sources, "skills.sh");
      addUnique(skill.sourceUrls, record.url);
      updated += 1;
    }

    if (updated > 0) {
      addUnique(repoEntry.sources, "skills.sh");
      addUnique(repoEntry.sourceUrls, repoUrl);
      stats.skillsShInstallsUpdated += updated;
    }
  } catch {
    // skills.sh may not have a package page for every Doist repository.
  }
}

async function fetchSkillsShInstallRecords(repoHtml, repoKey) {
  const records = parseSkillsShRepoInstallRecords(repoHtml, repoKey);
  await Promise.all(records.map(async (record) => {
    const detail = await fetchSkillsShSkillInstall(record.url);
    if (detail?.installs) {
      record.installs = detail.installs;
      record.name = detail.name || record.name;
    }
  }));
  return records.filter((record) => Number(record.installs || 0) > 0);
}

function parseSkillsShRepoInstallRecords(html, repoKey) {
  const records = [];
  const linkPattern = new RegExp(`<a\\b[^>]*href="/${escapeRegExp(repoKey)}/([^"#?]+)"[\\s\\S]*?<\\/a>`, "g");
  for (const match of html.matchAll(linkPattern)) {
    const block = match[0];
    const slug = decodeURIComponent(match[1]).replace(/\/$/, "");
    const countMatch = block.match(/<span[^>]*>\s*([0-9][0-9,.]*\s*[KMB]?)\s*<\/span>/i);
    if (!slug || !countMatch) continue;
    const headingMatch = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    records.push({
      slug,
      name: headingMatch ? stripHtml(headingMatch[1]) : slug,
      url: `${SKILLS_SH_ORIGIN}/${repoKey}/${encodeURIComponent(slug)}`,
      installs: parseInstallCount(countMatch[1])
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
        return { name: String(node.name || "").trim(), installs };
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
      "User-Agent": "Skillscout Doist importer"
    },
    signal: AbortSignal.timeout(SKILLS_SH_FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return response.text();
}

function findRepoSkill(repoKey, skillName) {
  const normalized = normalizeKey(skillName);
  for (const skill of directory.officialSkills) {
    if (skill.repoKey !== repoKey) continue;
    if (normalizeKey(skill.skillName) === normalized) return skill;
    if (normalizeKey(skill.displayName) === normalized) return skill;
    if (normalizeKey(String(skill.sourcePath || "").split("/").at(-2)) === normalized) return skill;
  }
  return null;
}

function refreshCounts() {
  const repoSkills = new Map();
  const ownerSkills = new Map();
  const ownerRepos = new Map();
  const repoInstalls = new Map();
  const ownerInstalls = new Map();
  const ownerStars = new Map();

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
    ownerStars.set(repo.ownerKey, (ownerStars.get(repo.ownerKey) || 0) + Number(repo.starsCount || 0));
  }

  for (const owner of directory.officialOwners) {
    owner.skillsCount = ownerSkills.get(owner.ownerKey) || 0;
    owner.reposCount = ownerRepos.get(owner.ownerKey) || 0;
    owner.installsCount = Math.max(Number(owner.installsCount || 0), ownerInstalls.get(owner.ownerKey) || 0);
    if (owner.ownerKey === OWNER_KEY) {
      owner.starsCount = Math.max(Number(owner.starsCount || 0), ownerStars.get(owner.ownerKey) || 0);
    }
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

function upsertSource(reposWithSkills) {
  directory.sources ||= {};
  directory.sources[SOURCE_ID] = {
    sourceId: SOURCE_ID,
    urls: [GITHUB_ORG_URL, OWNER_WEBSITE, TODOIST_WEBSITE],
    fetchedAt: now,
    status: "ok",
    note: "Doist official skills imported from verified GitHub organization repositories.",
    repos: reposWithSkills.map(({ repo, skillPaths }) => ({
      repo: repo.full_name,
      skillPaths
    }))
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
      "user-agent": "Skillscout Doist importer"
    }
  });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  return response.text();
}

function githubHeaders() {
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "Skillscout Doist importer"
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

function parseSkillMarkdown(markdown, skillPath) {
  const fallbackName = skillPath.split("/").at(-1);
  const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---/);
  const metadata = { name: fallbackName, description: "" };
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

function parseInstallCount(value) {
  const match = String(value || "").trim().replace(/,/g, "").match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMB])?$/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  const suffix = match[2]?.toUpperCase();
  const multiplier = suffix === "B" ? 1_000_000_000 : suffix === "M" ? 1_000_000 : suffix === "K" ? 1_000 : 1;
  return Math.round(amount * multiplier);
}

function extractJsonLd(html) {
  const records = [];
  const pattern = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  for (const match of html.matchAll(pattern)) {
    try {
      records.push(JSON.parse(decodeHtmlEntities(match[1])));
    } catch {
      // Skip invalid JSON-LD blocks.
    }
  }
  return records;
}

function stripHtml(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
