/**
 * Imports organization-owned skill repos from SkillsMP creators.
 *
 * SkillsMP exposes a paginated creators directory with GitHub owner slugs.
 * This script fetches the creator pages, keeps only GitHub Organizations via
 * GraphQL batch lookup, then adds missing repos and SKILL.md paths to the
 * Skillscout official directory.
 *
 * Run:
 *   GITHUB_TOKEN=$(gh auth token) node scripts/import_skillsmp_creators.mjs
 *
 * Env vars:
 *   GITHUB_TOKEN              optional if `gh auth token` works
 *   OFFICIAL_SKILLS_OUTPUT    optional — path to JSON (default: docs/data/official-skills-universal.json)
 *   SKILLSMP_START_PAGE       optional — first page to fetch (default: 1)
 *   SKILLSMP_MAX_PAGES        optional — last page to fetch (default: 500)
 *   SKILLSMP_LIST_CONCURRENCY optional — listing page concurrency (default: 8)
 *   SKILLSMP_DETAIL_CONCURRENCY optional — creator detail concurrency (default: 4)
 *   SKILLSMP_PROCESS_LIMIT    optional — max organization creators to process
 *   SKILLSMP_WRITE_INTERVAL   optional — checkpoint interval, 0 disables (default: 100)
 *   SKILLSMP_REFRESH_CACHE    optional — set to 1 to ignore cached listings/org checks
 *   SKILLSMP_REQUIRE_VERIFIED optional — set to 0 to allow unverified new orgs (default: 1)
 *   SKILLSMP_REQUIRE_WEBSITE  optional — set to 0 to allow new orgs without a website (default: 1)
 *   DRY_RUN                   optional — set to 1 to avoid writing JSON
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const DATA_PATH =
  process.env.OFFICIAL_SKILLS_OUTPUT ||
  path.join(root, "docs", "data", "official-skills-universal.json");

const SKILLSMP_ORIGIN = "https://skillsmp.com";
const SOURCE_ID = "skillsmp.com";
const DISCOVERY_SOURCE_ID = "github-discovery";
const START_PAGE = Math.max(1, Number(process.env.SKILLSMP_START_PAGE || 1));
const MAX_PAGES = Math.max(START_PAGE, Number(process.env.SKILLSMP_MAX_PAGES || 500));
const LIST_CONCURRENCY = Math.max(1, Number(process.env.SKILLSMP_LIST_CONCURRENCY || 8));
const DETAIL_CONCURRENCY = Math.max(1, Number(process.env.SKILLSMP_DETAIL_CONCURRENCY || 4));
const PROCESS_LIMIT = Number(process.env.SKILLSMP_PROCESS_LIMIT || 0);
const WRITE_INTERVAL = Math.max(0, Number(process.env.SKILLSMP_WRITE_INTERVAL || 100));
const REFRESH_CACHE = process.env.SKILLSMP_REFRESH_CACHE === "1" || process.env.SKILLSMP_REFRESH_CACHE === "true";
const REQUIRE_VERIFIED = process.env.SKILLSMP_REQUIRE_VERIFIED !== "0" && process.env.SKILLSMP_REQUIRE_VERIFIED !== "false";
const REQUIRE_WEBSITE = process.env.SKILLSMP_REQUIRE_WEBSITE !== "0" && process.env.SKILLSMP_REQUIRE_WEBSITE !== "false";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const CACHE_DIR = path.join(root, ".cache");
const CACHE_PATH = path.join(CACHE_DIR, `skillsmp-creators-${START_PAGE}-${MAX_PAGES}.json`);
const now = new Date().toISOString();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || readGhToken();
if (!GITHUB_TOKEN) {
  console.error("GITHUB_TOKEN is required, or `gh auth token` must work.");
  process.exit(1);
}

const ghHeaders = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  "User-Agent": "Skillscout SkillsMP importer",
  "X-GitHub-Api-Version": "2022-11-28"
};

const htmlHeaders = {
  Accept: "text/html,application/xhtml+xml",
  "User-Agent": "Skillscout SkillsMP importer"
};

const directory = JSON.parse(await fs.readFile(DATA_PATH, "utf8"));
const ownersByKey = new Map(directory.officialOwners.map((owner) => [owner.ownerKey, owner]));
const reposByKey = new Map(directory.officialRepos.map((repo) => [repo.repoKey, repo]));
const skillsByKey = new Map(directory.officialSkills.map((skill) => [skill.skillKey, skill]));
const skillCountByRepoKey = buildSkillCountByRepoKey(directory.officialSkills);
const ownerBySourceLogin = buildOwnerSourceLoginIndex(directory.officialOwners);

console.log(`Loaded ${directory.officialOwners.length} owners, ${directory.officialRepos.length} repos, ${directory.officialSkills.length} skills`);
let orgCreators = await loadCachedOrgCreators();
if (!orgCreators) {
  console.log(`Fetching SkillsMP creators pages ${START_PAGE}..${MAX_PAGES}`);

  const creators = await fetchCreatorListings();
  console.log(`SkillsMP creators found: ${creators.length}`);

  const candidateCreators = creators.filter((creator) => shouldCheckCreator(creator));
  console.log(`Candidate creators after local catalog filter: ${candidateCreators.length}`);

  const orgProfilesByLogin = await fetchOrganizationProfiles(candidateCreators.map((creator) => creator.ownerSlug));
  orgCreators = candidateCreators
    .map((creator) => ({ ...creator, profile: orgProfilesByLogin.get(creator.ownerSlug.toLowerCase()) }))
    .filter((creator) => creator.profile?.__typename === "Organization");
  await writeOrgCreatorsCache(orgCreators);
} else {
  console.log(`Using cached SkillsMP organization creators: ${orgCreators.length}`);
}

orgCreators = orgCreators.filter((creator) => shouldProcessOrgCreator(creator));

orgCreators.sort((a, b) => b.skillCount - a.skillCount || a.ownerSlug.localeCompare(b.ownerSlug));
if (PROCESS_LIMIT > 0) {
  orgCreators = orgCreators.slice(0, PROCESS_LIMIT);
}

console.log(`GitHub Organization creators to process: ${orgCreators.length}`);

const stats = {
  addedOwners: 0,
  mergedOwners: 0,
  addedRepos: 0,
  mergedRepos: 0,
  addedSkills: 0,
  mergedSkills: 0,
  skippedReposWithoutSkills: 0,
  skippedExistingRepos: 0,
  rejectedForks: 0,
  detailFailures: 0,
  repoFailures: 0,
  invalidOwnersRemoved: 0,
  invalidReposRemoved: 0,
  invalidSkillsRemoved: 0
};

const touchedOwnerKeys = new Set();
let completedCreators = 0;
let lastCheckpoint = 0;
await runPool(orgCreators, DETAIL_CONCURRENCY, async (creator, index) => {
  await processCreator(creator);
  completedCreators++;
  if (completedCreators % 25 === 0) {
    console.log(`  processed ${completedCreators}/${orgCreators.length}`);
  }
  if (!DRY_RUN && WRITE_INTERVAL > 0 && completedCreators - lastCheckpoint >= WRITE_INTERVAL) {
    lastCheckpoint = completedCreators;
    await persistDirectory(`checkpoint ${completedCreators}/${orgCreators.length}`);
  }
});

if (DRY_RUN) {
  console.log("DRY_RUN=1 — no file changes written");
} else {
  await persistDirectory("final");
}

console.log("Import summary:");
console.log(JSON.stringify(stats, null, 2));
console.log(`Directory: ${directory.stats.owners} owners, ${directory.stats.repos} repos, ${directory.stats.skills} skills`);

function readGhToken() {
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

async function loadCachedOrgCreators() {
  if (REFRESH_CACHE) return null;
  try {
    const cache = JSON.parse(await fs.readFile(CACHE_PATH, "utf8"));
    if (cache.startPage !== START_PAGE || cache.maxPages !== MAX_PAGES || !Array.isArray(cache.orgCreators)) {
      return null;
    }
    return cache.orgCreators;
  } catch {
    return null;
  }
}

async function writeOrgCreatorsCache(orgCreators) {
  if (DRY_RUN) return;
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(
    CACHE_PATH,
    `${JSON.stringify({ startPage: START_PAGE, maxPages: MAX_PAGES, generatedAt: now, orgCreators }, null, 2)}\n`
  );
  console.log(`Cached ${orgCreators.length} GitHub Organization creators at ${CACHE_PATH}`);
}

async function fetchCreatorListings() {
  const pages = [];
  for (let page = START_PAGE; page <= MAX_PAGES; page++) pages.push(page);

  const bySlug = new Map();
  await runPool(pages, LIST_CONCURRENCY, async (page) => {
    const url = page === 1 ? `${SKILLSMP_ORIGIN}/creators` : `${SKILLSMP_ORIGIN}/creators/page/${page}`;
    const html = await fetchText(url, htmlHeaders);
    for (const creator of parseListingCreators(html)) {
      const key = creator.ownerSlug.toLowerCase();
      const existing = bySlug.get(key);
      if (!existing || creator.skillCount > existing.skillCount) {
        bySlug.set(key, { ...creator, sourceUrl: `${SKILLSMP_ORIGIN}/creators/${creator.ownerSlug}` });
      }
    }
  });

  return [...bySlug.values()];
}

function parseListingCreators(html) {
  const text = decodeNextText(html);
  const re =
    /\{"owner":"([^"]+)","ownerSlug":"([^"]+)","ownerAvatar":"([^"]*)","repositoryCount":(\d+),"skillCount":(\d+),"stars":(\d+)/g;
  const creators = [];
  let match;
  while ((match = re.exec(text))) {
    creators.push({
      owner: match[1],
      ownerSlug: match[2],
      ownerAvatar: match[3],
      repositoryCount: Number(match[4]),
      skillCount: Number(match[5]),
      stars: Number(match[6])
    });
  }
  return creators;
}

function decodeNextText(html) {
  return String(html || "")
    .replace(/\\u0026/g, "&")
    .replace(/\\"/g, '"');
}

function shouldCheckCreator(creator) {
  const existingOwner = existingOwnerForCreator(creator);
  if (!existingOwner) return true;
  if (Number(existingOwner.skillsmpSkillCount || 0) >= Number(creator.skillCount || 0)) return false;
  const existingSkillCount = Number(existingOwner.skillsCount || 0);
  return creator.skillCount > existingSkillCount;
}

function shouldProcessOrgCreator(creator) {
  const existingOwner = existingOwnerForCreator(creator);
  if (existingOwner) return shouldCheckCreator(creator);
  if (!REQUIRE_VERIFIED) return true;
  if (creator.profile?.isVerified !== true) return false;
  if (REQUIRE_WEBSITE && !creator.profile?.websiteUrl) return false;
  return true;
}

function existingOwnerForCreator(creator) {
  const ownerKey = normalizeLogin(creator.ownerSlug);
  return ownersByKey.get(ownerKey) || ownerBySourceLogin.get(ownerKey);
}

async function fetchOrganizationProfiles(logins) {
  const uniqueLogins = [...new Set(logins.map((login) => login.toLowerCase()))];
  const profiles = new Map();
  const batches = chunk(uniqueLogins, 100);

  console.log(`Checking GitHub owner type for ${uniqueLogins.length} creators in ${batches.length} GraphQL batches`);
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const query = [
      "query(",
      batch.map((_, index) => `$login${index}: String!`).join(", "),
      ") {",
      batch
        .map(
          (_, index) => `
            o${index}: repositoryOwner(login: $login${index}) {
              __typename
              login
              ... on Organization {
                name
                url
                avatarUrl
                websiteUrl
                isVerified
                twitterUsername
                description
              }
            }`
        )
        .join("\n"),
      "}"
    ].join("\n");
    const variables = Object.fromEntries(batch.map((login, index) => [`login${index}`, login]));
    const data = await githubGraphql(query, variables);
    for (let index = 0; index < batch.length; index++) {
      const owner = data?.[`o${index}`];
      if (owner) profiles.set(batch[index], owner);
    }
    if ((i + 1) % 10 === 0 || i + 1 === batches.length) {
      console.log(`  GitHub GraphQL batches ${i + 1}/${batches.length}`);
    }
    await sleep(250);
  }

  return profiles;
}

async function processCreator(creator) {
  const ownerKey = normalizeLogin(creator.profile.login || creator.ownerSlug);
  const detail = await fetchCreatorDetail(creator.ownerSlug);
  if (!detail) {
    stats.detailFailures++;
    return;
  }

  const owner = upsertOwner(ownerKey, creator);
  touchedOwnerKeys.add(owner.ownerKey);
  let hadFailures = false;

  for (const repoFullName of detail.repoFullNames) {
    const [login, repoName] = repoFullName.split("/");
    if (!login || !repoName) continue;
    if (login.toLowerCase() !== creator.profile.login.toLowerCase()) continue;

    const repoKey = repoFullName.toLowerCase();
    const skillRecords = detail.skillRecordsByRepo.get(repoKey) || [];
    if (skillRecords.length === 0) continue;
    const detailSkillCount = skillRecords.length;
    const existingRepo = reposByKey.get(repoKey);
    const existingSkillCount = skillCountByRepoKey.get(repoKey) || Number(existingRepo?.skillsCount || 0);
    if (existingRepo && existingSkillCount >= detailSkillCount) {
      stats.skippedExistingRepos++;
      continue;
    }

    upsertRepoFromSkillRecords(owner.ownerKey, creator, repoFullName, skillRecords);
    for (const record of skillRecords) {
      upsertSkillFromRecord(owner.ownerKey, creator, record);
    }
  }

  if (!hadFailures) {
    owner.skillsmpSkillCount = Math.max(Number(owner.skillsmpSkillCount || 0), Number(creator.skillCount || 0));
    owner.skillsmpImportedAt = now;
  }
}

async function fetchCreatorDetail(ownerSlug) {
  const url = `${SKILLSMP_ORIGIN}/creators/${encodeURIComponent(ownerSlug)}`;
  const html = await fetchText(url, htmlHeaders);
  if (!html) return null;
  const text = decodeNextText(html);
  const repoFullNames = new Set();
  const repoSkillCounts = new Map();
  const repoSkillSlugs = new Map();
  const skillRecordsByRepo = new Map();
  const re = /href="https:\/\/github\.com\/([^"?#]+\/[^"?#/]+)"/g;
  let match;
  while ((match = re.exec(text))) {
    repoFullNames.add(match[1].replace(/\/+$/, ""));
  }
  const skillRe = new RegExp(`href="/creators/${escapeRegExp(ownerSlug)}/([^/"#]+)/([^/"#]+)"`, "g");
  while ((match = skillRe.exec(text))) {
    const repoName = match[1].toLowerCase();
    const skillSlug = match[2].toLowerCase();
    repoSkillCounts.set(repoName, (repoSkillCounts.get(repoName) || 0) + 1);
    if (!repoSkillSlugs.has(repoName)) repoSkillSlugs.set(repoName, new Set());
    repoSkillSlugs.get(repoName).add(skillSlug);
  }
  const githubSkillUrlRe = /https:\/\/github\.com\/[^"<>\\ ]+\/tree\/[^"<>\\ ]+/g;
  while ((match = githubSkillUrlRe.exec(text))) {
    const record = parseGithubSkillUrl(match[0]);
    if (!record) continue;
    const [login] = record.repoFullName.split("/");
    if (login.toLowerCase() !== ownerSlug.toLowerCase()) continue;
    repoFullNames.add(record.repoFullName);
    if (!skillRecordsByRepo.has(record.repoKey)) skillRecordsByRepo.set(record.repoKey, []);
    const records = skillRecordsByRepo.get(record.repoKey);
    if (!records.some((entry) => entry.skillPath === record.skillPath)) {
      records.push(record);
    }
  }
  return { repoFullNames: [...repoFullNames], repoSkillCounts, repoSkillSlugs, skillRecordsByRepo };
}

function upsertOwner(ownerKey, creator) {
  const existing = ownersByKey.get(ownerKey) || ownerBySourceLogin.get(ownerKey);
  const profile = creator.profile;
  const website = profile.websiteUrl || "";
  const ownerUrl = `${SKILLSMP_ORIGIN}/creators/${creator.ownerSlug}`;
  const githubUrl = profile.url || `https://github.com/${profile.login}`;
  const displayName = profile.name || creator.owner || profile.login;

  if (existing) {
    addUnique(existing.sources, DISCOVERY_SOURCE_ID);
    addUnique(existing.sources, SOURCE_ID);
    addUnique(existing.sourceUrls, ownerUrl);
    addUnique(existing.sourceUrls, githubUrl);
    addUnique(existing.normalizedNames, normalizeName(displayName));
    addUnique(existing.sourceOwnerKeys, profile.login);
    if (website) {
      existing.website ||= website;
      addUnique(existing.websiteHosts, hostnameFromUrl(website));
    }
    existing.githubUrl ||= githubUrl;
    existing.avatarUrl ||= profile.avatarUrl || creator.ownerAvatar;
    existing.logoUrl ||= profile.avatarUrl || creator.ownerAvatar;
    existing.orgType ||= "Organization";
    existing.githubVerified = existing.githubVerified || profile.isVerified === true;
    existing.lastSeenAt = now;
    stats.mergedOwners++;
    return existing;
  }

  const owner = {
    ownerKey,
    displayName,
    normalizedNames: unique([ownerKey, normalizeName(displayName), creator.ownerSlug]),
    sourceOwnerKeys: unique([profile.login, creator.ownerSlug]),
    websiteHosts: unique([hostnameFromUrl(website)]),
    website,
    sources: [DISCOVERY_SOURCE_ID, SOURCE_ID],
    sourceUrls: unique([ownerUrl, githubUrl]),
    skillsCount: 0,
    reposCount: 0,
    installsCount: 0,
    starsCount: Number(creator.stars || 0),
    confidence: profile.isVerified ? "high" : "medium",
    githubVerified: profile.isVerified === true,
    githubLogin: profile.login,
    githubUrl,
    orgType: "Organization",
    avatarUrl: profile.avatarUrl || creator.ownerAvatar,
    logoUrl: profile.avatarUrl || creator.ownerAvatar,
    firstSeenAt: now,
    lastSeenAt: now
  };
  if (profile.twitterUsername) owner.twitter = `@${profile.twitterUsername}`;
  directory.officialOwners.push(owner);
  ownersByKey.set(owner.ownerKey, owner);
  ownerBySourceLogin.set(profile.login.toLowerCase(), owner);
  stats.addedOwners++;
  return owner;
}

function upsertRepo(ownerKey, repo, creator, skillPaths, truncated) {
  const repoKey = repo.full_name.toLowerCase();
  const repoPage = `${SKILLSMP_ORIGIN}/creators/${creator.ownerSlug}/${repo.name}`;
  const existing = reposByKey.get(repoKey);

  if (existing) {
    addUnique(existing.sources, DISCOVERY_SOURCE_ID);
    addUnique(existing.sources, SOURCE_ID);
    addUnique(existing.sourceUrls, repo.html_url);
    addUnique(existing.sourceUrls, repoPage);
    addUnique(existing.sourceOwnerKeys, repo.owner.login);
    existing.skillsCount = Math.max(Number(existing.skillsCount || 0), skillPaths.length);
    existing.starsCount = Math.max(Number(existing.starsCount || 0), Number(repo.stargazers_count || 0));
    existing.githubSkillPaths = unique([...(existing.githubSkillPaths || []), ...skillPaths]);
    existing.truncated = Boolean(existing.truncated || truncated);
    existing.lastSeenAt = now;
    stats.mergedRepos++;
    return existing;
  }

  const entry = {
    repoKey,
    ownerKey,
    sourceOwnerKeys: [repo.owner.login],
    repoName: repo.name,
    displayName: repo.full_name,
    sources: [DISCOVERY_SOURCE_ID, SOURCE_ID],
    sourceUrls: unique([repo.html_url, repoPage]),
    skillsCount: skillPaths.length,
    installsCount: 0,
    starsCount: Number(repo.stargazers_count || 0),
    confidence: "high",
    firstSeenAt: now,
    lastSeenAt: now,
    githubSkillPaths: skillPaths,
    truncated
  };
  directory.officialRepos.push(entry);
  reposByKey.set(repoKey, entry);
  stats.addedRepos++;
  return entry;
}

function upsertRepoFromSkillRecords(ownerKey, creator, repoFullName, skillRecords) {
  const repoKey = repoFullName.toLowerCase();
  const [, repoName] = repoFullName.split("/");
  const repoUrl = `https://github.com/${repoFullName}`;
  const repoPage = `${SKILLSMP_ORIGIN}/creators/${creator.ownerSlug}/${repoName}`;
  const skillPaths = unique(skillRecords.map((record) => record.skillPath));
  const existing = reposByKey.get(repoKey);

  if (existing) {
    addUnique(existing.sources, DISCOVERY_SOURCE_ID);
    addUnique(existing.sources, SOURCE_ID);
    addUnique(existing.sourceUrls, repoUrl);
    addUnique(existing.sourceUrls, repoPage);
    addUnique(existing.sourceOwnerKeys, repoFullName.split("/")[0]);
    existing.skillsCount = Math.max(Number(existing.skillsCount || 0), skillPaths.length);
    existing.githubSkillPaths = unique([...(existing.githubSkillPaths || []), ...skillPaths]);
    existing.lastSeenAt = now;
    stats.mergedRepos++;
    return existing;
  }

  const entry = {
    repoKey,
    ownerKey,
    sourceOwnerKeys: [repoFullName.split("/")[0]],
    repoName,
    displayName: repoFullName,
    sources: [DISCOVERY_SOURCE_ID, SOURCE_ID],
    sourceUrls: unique([repoUrl, repoPage]),
    skillsCount: skillPaths.length,
    installsCount: 0,
    starsCount: 0,
    confidence: "high",
    firstSeenAt: now,
    lastSeenAt: now,
    githubSkillPaths: skillPaths,
    truncated: false
  };
  directory.officialRepos.push(entry);
  reposByKey.set(repoKey, entry);
  stats.addedRepos++;
  return entry;
}

function upsertSkill(ownerKey, repo, creator, skillPath) {
  const repoKey = repo.full_name.toLowerCase();
  const skillKey = `${repoKey}/${skillPath}`;
  const skillName = skillPath.split("/").filter(Boolean).at(-1);
  const skillUrl = `${SKILLSMP_ORIGIN}/creators/${creator.ownerSlug}/${repo.name}/${slugify(skillPath)}`;
  const githubUrl = `${repo.html_url}/tree/HEAD/${skillPath}`;
  const existing = skillsByKey.get(skillKey);

  if (existing) {
    addUnique(existing.sources, "github");
    addUnique(existing.sources, SOURCE_ID);
    addUnique(existing.sourceUrls, githubUrl);
    addUnique(existing.sourceUrls, skillUrl);
    addUnique(existing.sourceOwnerKeys, repo.owner.login);
    existing.lastSeenAt = now;
    stats.mergedSkills++;
    return existing;
  }

  const entry = {
    skillKey,
    ownerKey,
    sourceOwnerKeys: [repo.owner.login],
    repoKey,
    skillName,
    displayName: skillName,
    description: "",
    sources: ["github", SOURCE_ID],
    sourceUrls: unique([githubUrl, skillUrl]),
    installsCount: 0,
    confidence: "high",
    firstSeenAt: now,
    lastSeenAt: now
  };
  directory.officialSkills.push(entry);
  skillsByKey.set(skillKey, entry);
  skillCountByRepoKey.set(repoKey, (skillCountByRepoKey.get(repoKey) || 0) + 1);
  stats.addedSkills++;
  return entry;
}

function upsertSkillFromRecord(ownerKey, creator, record) {
  const repoName = record.repoFullName.split("/")[1];
  const skillKey = `${record.repoKey}/${record.skillPath}`;
  const skillName = record.skillPath.split("/").filter(Boolean).at(-1);
  const skillUrl = `${SKILLSMP_ORIGIN}/creators/${creator.ownerSlug}/${repoName}/${slugify(record.skillPath)}`;
  const existing = skillsByKey.get(skillKey);

  if (existing) {
    addUnique(existing.sources, "github");
    addUnique(existing.sources, SOURCE_ID);
    addUnique(existing.sourceUrls, record.githubUrl);
    addUnique(existing.sourceUrls, skillUrl);
    addUnique(existing.sourceOwnerKeys, record.repoFullName.split("/")[0]);
    existing.lastSeenAt = now;
    stats.mergedSkills++;
    return existing;
  }

  const entry = {
    skillKey,
    ownerKey,
    sourceOwnerKeys: [record.repoFullName.split("/")[0]],
    repoKey: record.repoKey,
    skillName,
    displayName: skillName,
    description: "",
    sources: ["github", SOURCE_ID],
    sourceUrls: unique([record.githubUrl, skillUrl]),
    installsCount: 0,
    confidence: "high",
    firstSeenAt: now,
    lastSeenAt: now
  };
  directory.officialSkills.push(entry);
  skillsByKey.set(skillKey, entry);
  skillCountByRepoKey.set(record.repoKey, (skillCountByRepoKey.get(record.repoKey) || 0) + 1);
  stats.addedSkills++;
  return entry;
}

async function fetchGithubRepo(repoFullName) {
  const res = await fetchWithRetry(`https://api.github.com/repos/${encodeURIComponent(repoFullName).replace("%2F", "/")}`, {
    headers: ghHeaders
  });
  if (!res.ok) return null;
  return res.json();
}

async function getSkillPaths(repoFullName, defaultBranch, allowedSkillSlugs = new Set()) {
  const branches = unique([defaultBranch, "HEAD"]);
  for (const branch of branches) {
    const url = `https://api.github.com/repos/${encodeURIComponent(repoFullName).replace("%2F", "/")}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
    const res = await fetchWithRetry(url, { headers: ghHeaders });
    if (!res.ok) continue;
    const data = await res.json();
    const paths = [];
    for (const item of data.tree || []) {
      if (item.type !== "blob") continue;
      const match = item.path.match(/(?:^|\/)(skill\.md)$/i);
      if (!match) continue;
      if (isTemplateSkillFilePath(item.path)) continue;
      const suffix = `/${match[1]}`;
      paths.push(
        item.path === match[1]
          ? normalizeLogin(repoFullName.split("/")[1])
          : normalizeLogin(item.path.slice(0, -suffix.length))
      );
    }
    const filteredPaths = allowedSkillSlugs.size
      ? paths.filter((skillPath) => allowedSkillSlugs.has(slugify(skillPath)))
      : [];
    return { paths: unique(filteredPaths), truncated: Boolean(data.truncated) };
  }
  return { paths: [], truncated: false };
}

function isTemplateSkillFilePath(filePath) {
  return /(^|\/)templates?\/skill\/SKILL\.md$/i.test(filePath);
}

async function githubGraphql(query, variables) {
  const res = await fetchWithRetry("https://api.github.com/graphql", {
    method: "POST",
    headers: ghHeaders,
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub GraphQL failed (${res.status}): ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  if (data.errors?.length) {
    throw new Error(`GitHub GraphQL errors: ${JSON.stringify(data.errors).slice(0, 800)}`);
  }
  return data.data;
}

async function fetchText(url, headers) {
  const res = await fetchWithRetry(url, { headers });
  if (!res.ok) return "";
  return res.text();
}

async function fetchWithRetry(url, options = {}) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, options);
    if (![403, 429, 500, 502, 503, 504].includes(res.status)) {
      return res;
    }

    const resetSeconds = Number(res.headers.get("x-ratelimit-reset") || 0);
    const retryAfter = Number(res.headers.get("retry-after") || 0);
    const resetDelay = resetSeconds
      ? Math.max(0, resetSeconds * 1000 - Date.now()) + 1000
      : 0;
    const fallbackDelay = Math.min(60_000, 2000 * attempt * attempt);
    const delay = retryAfter ? retryAfter * 1000 : resetDelay || fallbackDelay;
    console.warn(`  fetch retry ${attempt} after ${res.status}: waiting ${Math.round(delay / 1000)}s`);
    await sleep(delay);
  }
  return fetch(url, options);
}

function refreshTouchedOwnerCounts(ownerKeys) {
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
  for (const ownerKey of ownerKeys) {
    const owner = ownersByKey.get(ownerKey);
    if (!owner) continue;
    owner.reposCount = repoCountByOwner.get(ownerKey) || 0;
    owner.skillsCount = skillCountByOwner.get(ownerKey) || 0;
    owner.starsCount = Math.max(Number(owner.starsCount || 0), starsByOwner.get(ownerKey) || 0);
  }
}

function refreshStats() {
  directory.stats = {
    owners: directory.officialOwners.length,
    repos: directory.officialRepos.length,
    skills: directory.officialSkills.length,
    sourceOwners: countBySource(directory.officialOwners),
    sourceRepos: countBySource(directory.officialRepos),
    sourceSkills: countBySource(directory.officialSkills)
  };
}

async function persistDirectory(label) {
  removeInvalidOwners();
  refreshTouchedOwnerCounts(touchedOwnerKeys);
  sortDirectory();
  refreshStats();
  directory.generatedAt = now;
  await fs.writeFile(DATA_PATH, `${JSON.stringify(directory, null, 2)}\n`);
  console.log(`  wrote ${label}: ${directory.stats.owners} owners, ${directory.stats.repos} repos, ${directory.stats.skills} skills`);
}

function sortDirectory() {
  directory.officialOwners.sort((a, b) => a.ownerKey.localeCompare(b.ownerKey));
  directory.officialRepos.sort((a, b) => a.repoKey.localeCompare(b.repoKey));
  directory.officialSkills.sort((a, b) => a.skillKey.localeCompare(b.skillKey));
}

function removeInvalidOwners() {
  const ownerKeysWithSkills = new Set(
    (directory.officialSkills || [])
      .map((skill) => skill.ownerKey)
      .filter(Boolean)
  );
  const invalidOwnerKeys = new Set(
    (directory.officialOwners || [])
      .filter((owner) => isInvalidOfficialOwner(owner) || !ownerKeysWithSkills.has(owner.ownerKey))
      .map((owner) => owner.ownerKey)
  );
  if (!invalidOwnerKeys.size) return;

  const invalidRepoKeys = new Set(
    (directory.officialRepos || [])
      .filter((repo) => invalidOwnerKeys.has(repo.ownerKey))
      .map((repo) => repo.repoKey)
  );

  const before = {
    owners: directory.officialOwners.length,
    repos: directory.officialRepos.length,
    skills: directory.officialSkills.length
  };

  directory.officialOwners = directory.officialOwners.filter((owner) => !invalidOwnerKeys.has(owner.ownerKey));
  directory.officialRepos = directory.officialRepos.filter((repo) => !invalidOwnerKeys.has(repo.ownerKey));
  directory.officialSkills = directory.officialSkills.filter(
    (skill) => !invalidOwnerKeys.has(skill.ownerKey) && !invalidRepoKeys.has(skill.repoKey)
  );

  for (const ownerKey of invalidOwnerKeys) {
    ownersByKey.delete(ownerKey);
    touchedOwnerKeys.delete(ownerKey);
  }
  for (const repoKey of invalidRepoKeys) {
    reposByKey.delete(repoKey);
    skillCountByRepoKey.delete(repoKey);
  }
  for (const [login, owner] of ownerBySourceLogin) {
    if (invalidOwnerKeys.has(owner.ownerKey)) {
      ownerBySourceLogin.delete(login);
    }
  }
  for (const [skillKey, skill] of skillsByKey) {
    if (invalidOwnerKeys.has(skill.ownerKey) || invalidRepoKeys.has(skill.repoKey)) {
      skillsByKey.delete(skillKey);
    }
  }

  stats.invalidOwnersRemoved += before.owners - directory.officialOwners.length;
  stats.invalidReposRemoved += before.repos - directory.officialRepos.length;
  stats.invalidSkillsRemoved += before.skills - directory.officialSkills.length;
}

function isInvalidOfficialOwner(owner) {
  if (owner.ownerKey === "github") return false;
  if (owner.orgType === "User") return true;
  if (hasGithubWebsite(owner)) return true;
  if (!hasUsableWebsite(owner)) {
    if (owner.githubVerified === false) return true;
    return owner.orgType !== "Organization" && owner.githubVerified !== true;
  }
  return false;
}

function hasGithubWebsite(owner) {
  return hostnameFromUrl(owner.website) === "github.com" ||
    (owner.websiteHosts || []).some((host) => normalizeHost(host) === "github.com");
}

function hasUsableWebsite(owner) {
  const websiteHost = hostnameFromUrl(owner.website);
  if (websiteHost && websiteHost !== "github.com") return true;
  return (owner.websiteHosts || []).some((host) => {
    const normalizedHost = normalizeHost(host);
    return normalizedHost && normalizedHost !== "github.com";
  });
}

function countBySource(records) {
  const counts = {};
  for (const record of records || []) {
    for (const source of record.sources || []) {
      counts[source] = (counts[source] || 0) + 1;
    }
  }
  return counts;
}

function buildOwnerSourceLoginIndex(owners) {
  const index = new Map();
  for (const owner of owners) {
    index.set(String(owner.ownerKey).toLowerCase(), owner);
    for (const login of owner.sourceOwnerKeys || []) {
      index.set(String(login).toLowerCase(), owner);
    }
  }
  return index;
}

function buildSkillCountByRepoKey(skills) {
  const counts = new Map();
  for (const skill of skills || []) {
    if (!skill.repoKey) continue;
    counts.set(skill.repoKey, (counts.get(skill.repoKey) || 0) + 1);
  }
  return counts;
}

function parseGithubSkillUrl(url) {
  const match = String(url || "").match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/);
  if (!match) return null;
  const repoFullName = `${match[1]}/${match[2]}`;
  const skillPath = normalizeLogin(decodeURIComponent(match[4]).replace(/\/+$/, ""));
  if (!skillPath) return null;
  return {
    repoFullName,
    repoKey: repoFullName.toLowerCase(),
    branch: match[3],
    skillPath,
    githubUrl: `https://github.com/${repoFullName}/tree/${match[3]}/${skillPath}`
  };
}

function normalizeLogin(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function slugify(value) {
  return normalizeLogin(value).replace(/\//g, "-");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hostnameFromUrl(value) {
  try {
    if (!value) return "";
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function normalizeHost(value) {
  return String(value || "").trim().replace(/^www\./, "").toLowerCase();
}

function addUnique(list, value) {
  if (!value) return;
  if (!Array.isArray(list)) return;
  if (!list.includes(value)) list.push(value);
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
