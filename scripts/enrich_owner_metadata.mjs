import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyOwnerMetadataOverrides } from "./owner_metadata_overrides.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const DATA_PATH =
  process.env.OFFICIAL_SKILLS_OUTPUT || path.join(root, "docs", "data", "official-skills-universal.json");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const COMPANIES_KEY = process.env.COMPANIES_API_KEY;
const CONCURRENCY = Number(process.env.OWNER_METADATA_CONCURRENCY || 8);
const now = new Date().toISOString();

const githubHeaders = {
  Accept: "application/vnd.github+json",
  "User-Agent": "Skillscout owner metadata enricher",
  ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {})
};

const PLATFORM_DOMAINS = new Set([
  "github.com", "github.io", "gitlab.com", "bitbucket.org",
  "linkedin.com", "twitter.com", "x.com", "facebook.com",
  "linktr.ee", "linktree.com", "bio.link",
  "medium.com", "substack.com", "dev.to", "hashnode.com",
  "blogspot.com", "wordpress.com", "notion.site", "notion.so",
  "carrd.co", "beehiiv.com", "ghost.io",
  "vercel.app", "netlify.app", "pages.dev"
]);

const PLATFORM_NAMES = new Set([
  "github", "gitlab", "linkedin", "twitter", "facebook", "meta",
  "linktree", "medium", "blogspot", "wordpress", "notion", "vercel",
  "netlify", "cloudflare", "google", "microsoft", "amazon"
]);

const directory = JSON.parse(await fs.readFile(DATA_PATH, "utf8"));
const stats = {
  owners: directory.officialOwners.length,
  githubProfiles: 0,
  companyMatches: 0,
  userOwnersRemoved: 0,
  userReposRemoved: 0,
  userSkillsRemoved: 0,
  invalidOwnersRemoved: 0,
  invalidReposRemoved: 0,
  invalidSkillsRemoved: 0,
  websitesAdded: 0,
  twitterAdded: 0,
  avatarAdded: 0,
  logoAdded: 0,
  descriptionAdded: 0,
  locationAdded: 0,
  dbConfirmedAdded: 0,
  industryAdded: 0
};

await mapWithConcurrency(directory.officialOwners, CONCURRENCY, enrichOwner);
applyOwnerMetadataOverrides(directory, stats);
removeInvalidOwners(directory);
refreshDirectoryStats(directory);

directory.enrichedAt = now;
await fs.writeFile(DATA_PATH, `${JSON.stringify(directory, null, 2)}\n`);

Object.assign(stats, {
  withAvatar: countOwnersWith("avatarUrl"),
  withLogo: countOwnersWith("logoUrl"),
  withGithubUrl: countOwnersWith("githubUrl"),
  withWebsite: countOwnersWith("website"),
  withCompanyName: countOwnersWith("companyName"),
  withCompanyDomain: countOwnersWith("companyDomain"),
  withIndustry: countOwnersWith("companyIndustry"),
  withDescription: countOwnersWith("description"),
  withTwitter: countOwnersWith("twitter"),
  users: directory.officialOwners.filter((owner) => owner.orgType === "User").length,
  organizations: directory.officialOwners.filter((owner) => owner.orgType === "Organization").length
});

console.log(
  `Owner metadata: ${stats.githubProfiles}/${stats.owners} GitHub profiles, ` +
    `${stats.companyMatches} company matches, ${stats.withLogo}/${stats.owners} logos, ` +
    `${stats.withWebsite}/${stats.owners} websites, ${stats.invalidOwnersRemoved} invalid owners removed`
);

async function enrichOwner(owner) {
  const profile = await fetchFirstGitHubProfile(owner);
  if (profile) {
    stats.githubProfiles++;
    mergeGitHubProfile(owner, profile);
  }

  owner.websiteHosts ||= [];
  const websiteHost = hostFromUrl(owner.website);
  if (websiteHost) {
    addUnique(owner.websiteHosts, websiteHost);
  }

  const hadDbConfirmed = Boolean(owner.dbConfirmed);
  const company = await lookupCompany(websiteHost);
  if (company) {
    stats.companyMatches++;
    mergeCompany(owner, company);
    if (!hadDbConfirmed && owner.dbConfirmed) {
      stats.dbConfirmedAdded++;
    }
  } else if (!owner.logoUrl && owner.avatarUrl) {
    owner.logoUrl = owner.avatarUrl;
    stats.logoAdded++;
  }

  owner.lastSeenAt = now;
}

async function fetchFirstGitHubProfile(owner) {
  for (const login of ownerGithubCandidates(owner)) {
    const profile = await fetchGitHubProfile(login);
    if (profile) {
      return profile;
    }
  }
  return null;
}

async function fetchGitHubProfile(login) {
  for (const endpoint of ["orgs", "users"]) {
    const response = await fetch(`https://api.github.com/${endpoint}/${encodeURIComponent(login)}`, {
      headers: githubHeaders
    });
    if (response.status === 404) {
      continue;
    }
    if (!response.ok) {
      return null;
    }
    return response.json();
  }
  return null;
}

function mergeGitHubProfile(owner, profile) {
  const login = profile.login || owner.ownerKey;
  owner.githubLogin = login;
  owner.githubUrl = profile.html_url || `https://github.com/${login}`;
  owner.orgType = profile.type || owner.orgType;

  if (profile.avatar_url) {
    if (!owner.avatarUrl) stats.avatarAdded++;
    owner.avatarUrl = profile.avatar_url;
  }

  if (profile.name) {
    owner.companyName ||= profile.name;
    owner.displayName = chooseDisplayName(owner.displayName, profile.name);
    addUnique(owner.normalizedNames, normalizeName(profile.name));
  }

  const description = profile.description || profile.bio || "";
  if (description && !owner.description) {
    owner.description = description;
    stats.descriptionAdded++;
  }

  if (profile.location && !owner.location) {
    owner.location = profile.location;
    stats.locationAdded++;
  }

  if (profile.twitter_username && !owner.twitter) {
    owner.twitter = `@${profile.twitter_username}`;
    stats.twitterAdded++;
  }

  if (profile.blog && !owner.website) {
    owner.website = profile.blog;
    stats.websitesAdded++;
  }

  addUnique(owner.sourceOwnerKeys, login);
  addUnique(owner.sourceUrls, owner.githubUrl);
}

async function lookupCompany(hostname) {
  if (!COMPANIES_KEY || !hostname || isPlatformHost(hostname)) {
    return null;
  }

  const candidates = [hostname];
  const root = rootDomain(hostname);
  if (root && root !== hostname) {
    candidates.push(root);
  }

  for (const domain of candidates) {
    const response = await fetch(
      `https://api.thecompaniesapi.com/v1/companies/${encodeURIComponent(domain)}?free=true`,
      { headers: { Authorization: `Bearer ${COMPANIES_KEY}` } }
    );
    if (response.status === 404) {
      continue;
    }
    if (!response.ok) {
      continue;
    }
    const company = await response.json().catch(() => null);
    if (!company?.name) {
      continue;
    }
    const normalizedName = String(company.name).toLowerCase().replace(/[^a-z]/g, "");
    if (PLATFORM_NAMES.has(normalizedName)) {
      continue;
    }
    return { ...company, matchedDomain: domain };
  }

  return null;
}

function mergeCompany(owner, company) {
  const industries = Array.isArray(company.industries) ? company.industries.filter(Boolean) : [];
  owner.dbConfirmed = true;
  owner.companyName = company.name || owner.companyName || owner.displayName;
  owner.companyDomain = company.domain || company.matchedDomain || hostFromUrl(owner.website);

  if (industries.length && !owner.companyIndustry) {
    owner.companyIndustry = industries.slice(0, 3).join(", ");
    stats.industryAdded++;
  }

  if (company.logo) {
    owner.companyLogoUrl = company.logo;
    if (!owner.logoUrl) {
      owner.logoUrl = company.logo;
      stats.logoAdded++;
    }
  }

  if (!owner.logoUrl && owner.avatarUrl) {
    owner.logoUrl = owner.avatarUrl;
    stats.logoAdded++;
  }

  if (!owner.website && owner.companyDomain) {
    owner.website = `https://${owner.companyDomain}`;
    stats.websitesAdded++;
  }

  if (!owner.description && company.description) {
    owner.description = company.description;
    stats.descriptionAdded++;
  }
}

function ownerGithubCandidates(owner) {
  const candidates = [];
  for (const url of owner.sourceUrls || []) {
    const match = url.match(/^https:\/\/github\.com\/([^/#?]+)/);
    if (match) {
      candidates.push(match[1]);
    }
  }
  for (const key of owner.sourceOwnerKeys || []) {
    if (key && !key.includes("/") && !key.includes(".") && !key.includes("#")) {
      candidates.push(key);
    }
  }
  candidates.push(owner.ownerKey);
  return [...new Set(candidates.filter(Boolean))];
}

function normalizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.startsWith("http") ? raw : `https://${raw}`;
}

function hostFromUrl(value) {
  try {
    return new URL(normalizeUrl(value)).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function rootDomain(hostname) {
  const parts = String(hostname || "").split(".").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join(".") : hostname;
}

function isPlatformHost(hostname) {
  const root = rootDomain(hostname);
  return PLATFORM_DOMAINS.has(hostname) || PLATFORM_DOMAINS.has(root);
}

function chooseDisplayName(current, next) {
  const currentValue = String(current || "").trim();
  const nextValue = String(next || "").trim();
  if (!currentValue) return nextValue;
  if (!nextValue) return currentValue;
  if (currentValue === currentValue.toLowerCase() && nextValue !== nextValue.toLowerCase()) return nextValue;
  if (nextValue.length < currentValue.length && !nextValue.includes("-")) return nextValue;
  return currentValue;
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function addUnique(list, value) {
  if (!value || list.includes(value)) {
    return;
  }
  list.push(value);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      await mapper(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
}

function countOwnersWith(field) {
  return directory.officialOwners.filter((owner) => owner[field]).length;
}

function removeInvalidOwners(directory) {
  const invalidOwnerKeys = new Set(
    (directory.officialOwners || [])
      .filter(isInvalidOfficialOwner)
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

  stats.userOwnersRemoved = before.owners - directory.officialOwners.length;
  stats.userReposRemoved = before.repos - directory.officialRepos.length;
  stats.userSkillsRemoved = before.skills - directory.officialSkills.length;
  stats.invalidOwnersRemoved = stats.userOwnersRemoved;
  stats.invalidReposRemoved = stats.userReposRemoved;
  stats.invalidSkillsRemoved = stats.userSkillsRemoved;
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
  return hostFromUrl(owner.website) === "github.com" ||
    (owner.websiteHosts || []).some((host) => normalizeHost(host) === "github.com");
}

function hasUsableWebsite(owner) {
  const websiteHost = hostFromUrl(owner.website);
  if (websiteHost && websiteHost !== "github.com") return true;
  return (owner.websiteHosts || []).some((host) => {
    const normalizedHost = normalizeHost(host);
    return normalizedHost && normalizedHost !== "github.com";
  });
}

function normalizeHost(value) {
  return String(value || "").trim().replace(/^www\./, "").toLowerCase();
}

function refreshDirectoryStats(directory) {
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
