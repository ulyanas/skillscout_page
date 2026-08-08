/**
 * Imports official skills from ClawHub.
 *
 * ClawHub exposes its official publisher list through Convex. This importer
 * merges skills into existing owners where possible and creates ClawHub source
 * packs for skills that do not have a GitHub/skills.sh repo mapping yet.
 *
 * Run:
 *   node scripts/import_clawhub_official.mjs
 *
 * Env vars:
 *   OFFICIAL_SKILLS_OUTPUT optional — path to JSON (default: docs/data/official-skills-universal.json)
 *   DRY_RUN                optional — set to 1 to avoid writing JSON
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const DATA_PATH =
  process.env.OFFICIAL_SKILLS_OUTPUT ||
  path.join(root, "docs", "data", "official-skills-universal.json");
const CACHE_DIR = path.join(root, ".cache", "clawhub");
const CACHE_PATH = path.join(CACHE_DIR, "official.json");
const SOURCE_ID = "clawhub.ai";
const CLAWHUB_ORIGIN = "https://clawhub.ai";
const CONVEX_URL = "https://wry-manatee-359.convex.cloud/api/query";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const now = new Date().toISOString();

const OWNER_ALIASES = new Map([
  ["amazon-web-services", "aws"],
  ["hugging-face", "huggingface"],
  ["z-ai", "zai-org"]
]);

const OWNER_WEBSITE_OVERRIDES = {
  "ant-intl": "https://www.ant-intl.com/",
  cua: "https://cua.ai/",
  "heygen-com": "https://www.heygen.com/",
  opensea: "https://opensea.io/",
  tinyfish: "https://www.tinyfish.ai/",
  vibethon: "https://b150.ai/vibeathon",
  "zai-org": "https://z.ai/"
};

const data = JSON.parse(await fs.readFile(DATA_PATH, "utf8"));
const ownersByKey = new Map(data.officialOwners.map((owner) => [owner.ownerKey, owner]));
const reposByKey = new Map(data.officialRepos.map((repo) => [repo.repoKey, repo]));
const ownerIndex = buildOwnerIndex(data.officialOwners);

const payload = await fetchClawHubOfficial();
const publishers = payload.page || [];
const stats = {
  publishers: publishers.length,
  skillPublishers: 0,
  pluginOnlyPublishers: 0,
  addedOwners: 0,
  mergedOwners: 0,
  addedRepos: 0,
  mergedRepos: 0,
  addedSkills: 0,
  mergedSkills: 0
};

for (const publisher of publishers) {
  const skillItems = (publisher.publishedItems || []).filter((item) => item.kind === "skill");
  if (!skillItems.length) {
    stats.pluginOnlyPublishers += 1;
    continue;
  }

  stats.skillPublishers += 1;
  const owner = upsertOwner(publisher);
  let repo = null;

  for (const item of skillItems) {
    const existing = findExistingSkill(owner.ownerKey, item);
    if (existing) {
      mergeSkill(existing, owner, publisher, item);
      stats.mergedSkills += 1;
      continue;
    }

    repo ||= upsertClawHubRepo(owner, publisher, skillItems);
    data.officialSkills.push(createSkill(owner, repo, publisher, item));
    stats.addedSkills += 1;
  }
}

refreshCounts();
sanitizeClawHubVerification();
upsertSource(payload);
data.generatedAt = now;
data.enrichedAt = now;
data.officialOwners.sort((a, b) => a.ownerKey.localeCompare(b.ownerKey));
data.officialRepos.sort((a, b) => a.repoKey.localeCompare(b.repoKey));
data.officialSkills.sort((a, b) => a.skillKey.localeCompare(b.skillKey));

console.log(JSON.stringify(stats, null, 2));

if (!DRY_RUN) {
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(`Wrote ${DATA_PATH}`);
}

async function fetchClawHubOfficial() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const body = {
    path: "publishers:listPublicPage",
    args: {
      kind: "org",
      official: true,
      paginationOpts: {
        cursor: null,
        numItems: 100
      }
    },
    format: "json"
  };

  const response = await fetch(CONVEX_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "Skillscout ClawHub importer"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`ClawHub query failed: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  await fs.writeFile(CACHE_PATH, text, "utf8");
  const json = JSON.parse(text);
  if (json.status !== "success") {
    throw new Error(`ClawHub query returned ${json.status || "unknown"} status`);
  }
  return json.value;
}

function upsertOwner(publisher) {
  const ownerKey = resolveOwnerKey(publisher);
  const displayName = cleanText(publisher.displayName) || prettifyName(ownerKey);
  const sourceUrl = `${CLAWHUB_ORIGIN}/${publisher.handle}`;
  let owner = ownersByKey.get(ownerKey);

  if (!owner) {
    owner = {
      ownerKey,
      displayName,
      normalizedNames: unique([
        normalizeName(ownerKey),
        normalizeName(publisher.handle),
        normalizeName(displayName)
      ]),
      sources: [SOURCE_ID],
      sourceUrls: [sourceUrl],
      websiteUrls: [],
      websiteHosts: [],
      skillsCount: 0,
      reposCount: 0,
      installsCount: 0,
      starsCount: 0,
      confidence: "high",
      official: true
    };
    data.officialOwners.push(owner);
    ownersByKey.set(ownerKey, owner);
    stats.addedOwners += 1;
  } else {
    stats.mergedOwners += 1;
  }

  owner.displayName = chooseDisplayName(owner.displayName, displayName);
  owner.description ||= cleanText(publisher.bio);
  owner.avatarUrl ||= publisher.image || "";
  owner.logoUrl ||= publisher.image || owner.avatarUrl || "";
  owner.official = true;
  owner.confidence = "high";
  addUnique(owner.sources, SOURCE_ID);
  addUnique(owner.sourceUrls, sourceUrl);
  addUnique(owner.sourceOwnerKeys, publisher.handle);
  addUnique(owner.normalizedNames, normalizeName(ownerKey));
  addUnique(owner.normalizedNames, normalizeName(publisher.handle));
  addUnique(owner.normalizedNames, normalizeName(displayName));

  const website = OWNER_WEBSITE_OVERRIDES[ownerKey];
  if (website) {
    addUnique(owner.websiteUrls, website);
    addUnique(owner.websiteHosts, hostname(website));
    owner.websiteUrl ||= website;
  }

  owner.clawhubDownloadsCount = Math.max(
    Number(owner.clawhubDownloadsCount || 0),
    Number(publisher.stats?.downloads || 0)
  );
  owner.clawhubInstallsCount = Math.max(
    Number(owner.clawhubInstallsCount || 0),
    Number(publisher.stats?.installs || 0)
  );
  owner.starsCount = Math.max(Number(owner.starsCount || 0), Number(publisher.stats?.stars || 0));
  owner.lastSeenAt = now;

  ownerIndex.set(ownerKey, ownerKey);
  ownerIndex.set(normalizeName(publisher.handle), ownerKey);
  ownerIndex.set(normalizeName(displayName), ownerKey);
  return owner;
}

function upsertClawHubRepo(owner, publisher, skillItems) {
  const repoKey = `${SOURCE_ID}/${owner.ownerKey}`;
  const sourceUrl = `${CLAWHUB_ORIGIN}/${publisher.handle}`;
  let repo = reposByKey.get(repoKey);

  if (!repo) {
    repo = {
      repoKey,
      ownerKey: owner.ownerKey,
      repoName: SOURCE_ID,
      displayName: `${owner.displayName} on ClawHub`,
      description: cleanText(publisher.bio) || `${owner.displayName} official ClawHub skills.`,
      sources: [SOURCE_ID],
      sourceUrls: [sourceUrl],
      skillsCount: 0,
      installsCount: 0,
      starsCount: 0,
      confidence: "high",
      official: true,
      installCommandTemplate: "openclaw skills install @{ownerHandle}/{skillName}",
      sourceKind: "clawhub"
    };
    data.officialRepos.push(repo);
    reposByKey.set(repoKey, repo);
    stats.addedRepos += 1;
  } else {
    stats.mergedRepos += 1;
  }

  addUnique(repo.sources, SOURCE_ID);
  addUnique(repo.sourceUrls, sourceUrl);
  repo.ownerKey = owner.ownerKey;
  repo.displayName = chooseDisplayName(repo.displayName, `${owner.displayName} on ClawHub`);
  repo.description ||= cleanText(publisher.bio) || `${owner.displayName} official ClawHub skills.`;
  repo.confidence = "high";
  repo.official = true;
  repo.installCommandTemplate = "openclaw skills install @{ownerHandle}/{skillName}";
  repo.sourceKind = "clawhub";
  repo.ownerHandle = publisher.handle;
  repo.clawhubDownloadsCount = sum(skillItems.map((item) => item.downloads));
  repo.clawhubInstallsCount = sum(skillItems.map((item) => item.installs));
  repo.installsCount = Math.max(Number(repo.installsCount || 0), repo.clawhubInstallsCount);
  repo.starsCount = Math.max(Number(repo.starsCount || 0), Number(publisher.stats?.stars || 0));
  repo.lastSeenAt = now;

  return repo;
}

function createSkill(owner, repo, publisher, item) {
  const slug = normalizeSkillName(item.slug || item.displayName);
  const sourceUrl = `${CLAWHUB_ORIGIN}/${publisher.handle}/skills/${slug}`;
  return {
    skillKey: `${repo.repoKey}/${slug}`,
    ownerKey: owner.ownerKey,
    repoKey: repo.repoKey,
    skillName: slug,
    displayName: cleanText(item.displayName) || prettifyName(slug),
    description: cleanText(item.summary),
    sources: [SOURCE_ID],
    sourceUrls: [sourceUrl],
    installsCount: Number(item.installs || 0),
    downloadsCount: Number(item.downloads || 0),
    clawhubDownloadsCount: Number(item.downloads || 0),
    clawhubInstallsCount: Number(item.installs || 0),
    confidence: "high",
    official: true,
    ownerHandle: publisher.handle,
    installCommand: `openclaw skills install @${publisher.handle}/${slug}`,
    firstSeenAt: now,
    lastSeenAt: now
  };
}

function findExistingSkill(ownerKey, item) {
  const slug = normalizeSkillName(item.slug || item.displayName);
  const displayName = normalizeName(item.displayName || "");
  const matches = data.officialSkills.filter((skill) => {
    if (skill.ownerKey !== ownerKey) return false;
    const skillName = normalizeSkillName(skill.skillName || "");
    const skillDisplay = normalizeName(skill.displayName || "");
    return skillName === slug || skillDisplay === displayName || skill.skillKey?.endsWith(`/${slug}`);
  });

  return matches.sort((left, right) => {
    const leftPreferred = Number(left.sources?.includes("skills.sh")) + Number(left.sources?.includes("github"));
    const rightPreferred = Number(right.sources?.includes("skills.sh")) + Number(right.sources?.includes("github"));
    return rightPreferred - leftPreferred || String(left.skillKey).localeCompare(String(right.skillKey));
  })[0];
}

function mergeSkill(skill, owner, publisher, item) {
  const slug = normalizeSkillName(item.slug || item.displayName);
  addUnique(skill.sources, SOURCE_ID);
  addUnique(skill.sourceUrls, `${CLAWHUB_ORIGIN}/${publisher.handle}/skills/${slug}`);
  skill.displayName = chooseDisplayName(skill.displayName, cleanText(item.displayName) || prettifyName(slug));
  skill.description ||= cleanText(item.summary);
  skill.installsCount = Math.max(Number(skill.installsCount || 0), Number(item.installs || 0));
  skill.downloadsCount = Math.max(Number(skill.downloadsCount || 0), Number(item.downloads || 0));
  skill.clawhubDownloadsCount = Number(item.downloads || 0);
  skill.clawhubInstallsCount = Number(item.installs || 0);
  skill.official = true;
  skill.confidence = "high";
  skill.ownerHandle = publisher.handle;
  skill.installCommand ||= `openclaw skills install @${publisher.handle}/${slug}`;
  skill.lastSeenAt = now;
  addUnique(owner.sourceUrls, `${CLAWHUB_ORIGIN}/${publisher.handle}/skills/${slug}`);
}

function resolveOwnerKey(publisher) {
  const candidates = [
    normalizeOwnerKey(publisher.handle),
    normalizeOwnerKey(publisher.displayName),
    OWNER_ALIASES.get(normalizeOwnerKey(publisher.handle)),
    OWNER_ALIASES.get(normalizeOwnerKey(publisher.displayName))
  ].filter(Boolean);

  for (const candidate of candidates) {
    const indexed = ownerIndex.get(candidate) || ownerIndex.get(normalizeName(candidate));
    if (indexed) return indexed;
    if (ownersByKey.has(candidate)) return candidate;
  }

  return candidates[0];
}

function refreshCounts() {
  const repoSkills = new Map();
  const ownerSkills = new Map();
  const ownerRepos = new Map();
  const repoInstalls = new Map();
  const ownerInstalls = new Map();

  for (const skill of data.officialSkills) {
    if (!skill.repoKey || !skill.ownerKey) continue;
    repoSkills.set(skill.repoKey, (repoSkills.get(skill.repoKey) || 0) + 1);
    ownerSkills.set(skill.ownerKey, (ownerSkills.get(skill.ownerKey) || 0) + 1);
    repoInstalls.set(skill.repoKey, (repoInstalls.get(skill.repoKey) || 0) + Number(skill.installsCount || 0));
  }

  data.officialRepos = data.officialRepos.filter((repo) => repoSkills.has(repo.repoKey));

  for (const repo of data.officialRepos) {
    if (!repo.ownerKey) continue;
    ownerRepos.set(repo.ownerKey, (ownerRepos.get(repo.ownerKey) || 0) + 1);
    repo.skillsCount = repoSkills.get(repo.repoKey) || 0;
    repo.installsCount = Math.max(Number(repo.installsCount || 0), repoInstalls.get(repo.repoKey) || 0);
    ownerInstalls.set(repo.ownerKey, (ownerInstalls.get(repo.ownerKey) || 0) + Number(repo.installsCount || 0));
  }

  for (const owner of data.officialOwners) {
    owner.skillsCount = ownerSkills.get(owner.ownerKey) || 0;
    owner.reposCount = ownerRepos.get(owner.ownerKey) || 0;
    owner.installsCount = Math.max(Number(owner.installsCount || 0), ownerInstalls.get(owner.ownerKey) || 0);
  }

  data.stats = {
    owners: data.officialOwners.length,
    repos: data.officialRepos.length,
    skills: data.officialSkills.length,
    sourceOwners: countBySource(data.officialOwners),
    sourceRepos: countBySource(data.officialRepos),
    sourceSkills: countBySource(data.officialSkills)
  };
}

function sanitizeClawHubVerification() {
  for (const owner of data.officialOwners) {
    if ((owner.sources || []).includes(SOURCE_ID) && !(owner.sources || []).includes("github-discovery")) {
      delete owner.githubVerified;
    }
  }

  for (const repo of data.officialRepos) {
    if (repo.sourceKind === "clawhub") {
      delete repo.githubVerified;
    }
  }

  for (const skill of data.officialSkills) {
    if ((skill.sources || []).includes(SOURCE_ID) && !(skill.sources || []).includes("github")) {
      delete skill.githubVerified;
    }
  }
}

function upsertSource(payload) {
  const raw = JSON.stringify(payload);
  data.sources ||= {};
  data.sources[SOURCE_ID] = {
    sourceId: SOURCE_ID,
    urls: [`${CLAWHUB_ORIGIN}/official`],
    fetchedAt: now,
    status: "ok",
    fetches: [
      {
        fetchId: SOURCE_ID,
        url: `${CLAWHUB_ORIGIN}/official`,
        fetchedAt: now,
        status: 200,
        etag: null,
        hash: `sha256:${crypto.createHash("sha256").update(raw).digest("hex")}`,
        bytes: Buffer.byteLength(raw)
      }
    ]
  };
}

function buildOwnerIndex(owners) {
  const index = new Map();
  for (const owner of owners) {
    const keys = [
      owner.ownerKey,
      owner.githubLogin,
      owner.displayName,
      ...(owner.normalizedNames || []),
      ...(owner.sourceOwnerKeys || [])
    ];
    for (const key of keys) {
      const normalized = normalizeName(key);
      if (normalized) index.set(normalized, owner.ownerKey);
      const ownerKey = normalizeOwnerKey(key);
      if (ownerKey) index.set(ownerKey, owner.ownerKey);
    }
  }
  return index;
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

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function chooseDisplayName(current, candidate) {
  const cleanCurrent = cleanText(current);
  const cleanCandidate = cleanText(candidate);
  if (!cleanCurrent) return cleanCandidate;
  if (!cleanCandidate) return cleanCurrent;
  if (cleanCurrent === cleanCurrent.toLowerCase() && cleanCandidate !== cleanCandidate.toLowerCase()) {
    return cleanCandidate;
  }
  return cleanCurrent;
}

function normalizeOwnerKey(value) {
  const key = normalizeKey(value);
  return OWNER_ALIASES.get(key) || key;
}

function normalizeSkillName(value) {
  return normalizeKey(value);
}

function normalizeName(value) {
  return normalizeKey(value).replace(/[._/-]+/g, "-");
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

function hostname(value) {
  try {
    return new URL(value).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}
