import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_KEY = "google/skills";
const REPO_URL = `https://github.com/${REPO_KEY}`;
const INDEX_URL = "https://raw.githubusercontent.com/google/skills/main/index.json";
const ENTRY_PREFIX = "https://raw.githubusercontent.com/google/skills/main/skills/";
const unique = (values) => [...new Set(values)];

// Google's index identifies canonical skills and their installation names.
export function importGoogleSkills(directory, index, now = new Date().toISOString()) {
  if (!Array.isArray(index.skills) || !index.skills.length) throw new Error("Google skill index is empty");
  const names = new Set();
  const paths = new Set();
  const entries = index.skills.map((entry) => {
    if (!/^[a-z0-9-]+$/.test(entry.name) || names.has(entry.name)) throw new Error("Invalid or duplicate Google skill name");
    if (!entry.entrypoint?.startsWith(ENTRY_PREFIX) || !entry.entrypoint.endsWith("/SKILL.md")) {
      throw new Error("Unexpected Google skill entrypoint");
    }
    const skillPath = `skills/${entry.entrypoint.slice(ENTRY_PREFIX.length, -"/SKILL.md".length)}`;
    if (paths.has(skillPath) || skillPath.split("/").includes("..")) throw new Error("Invalid or duplicate Google skill path");
    const description = String(entry.description || "").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+(?=[A-Z])/)[0];
    if (!description) throw new Error(`Missing description for ${entry.name}`);
    names.add(entry.name);
    paths.add(skillPath);
    return { ...entry, skillPath, description };
  });

  let owner = directory.officialOwners.find((item) => item.ownerKey === "google");
  if (!owner) {
    owner = { ownerKey: "google", sources: [], sourceUrls: [], firstSeenAt: now, installsCount: 0, starsCount: 0 };
    directory.officialOwners.push(owner);
  }
  Object.assign(owner, {
    displayName: "Google", normalizedNames: ["google"], sourceOwnerKeys: ["google"],
    website: "https://opensource.google/", websiteHosts: ["opensource.google"],
    githubUrl: "https://github.com/google", githubLogin: "google", confidence: "high", lastSeenAt: now
  });
  owner.sources = unique([...owner.sources, "github-discovery"]);
  owner.sourceUrls = unique([...owner.sourceUrls, "https://github.com/google", REPO_URL]);

  let repo = directory.officialRepos.find((item) => item.repoKey === REPO_KEY);
  if (!repo) {
    repo = { repoKey: REPO_KEY, sources: [], sourceUrls: [], firstSeenAt: now, installsCount: 0, starsCount: 0 };
    directory.officialRepos.push(repo);
  }
  Object.assign(repo, {
    ownerKey: "google", sourceOwnerKeys: ["google"], repoName: "skills", displayName: REPO_KEY,
    description: "Deploy services to Cloud Run and GKE, build Gemini applications, query BigQuery, configure cloud IAM and monitoring, and integrate Google Ads and Analytics APIs.",
    canonicalRepoKey: REPO_KEY, githubDefaultBranch: "main", confidence: "high",
    githubSkillPaths: [...paths].sort(), githubSkillPathsFetchedAt: now, truncated: false,
    skillPathPrefixes: ["skills/"], installCommand: "npx skills add google/skills",
    installCommandTemplate: "npx skills add google/skills --skill {skillName}", lastSeenAt: now
  });
  repo.sources = unique([...repo.sources, "github-discovery"]);
  repo.sourceUrls = unique([...repo.sourceUrls, REPO_URL, INDEX_URL]);

  const previous = directory.officialSkills.filter((item) => item.repoKey === REPO_KEY);
  const skills = entries.map((entry) => {
    const skillKey = `${REPO_KEY}/${entry.skillPath}`;
    const existing = previous.find((item) => item.skillKey === skillKey);
    const folderName = entry.skillPath.split("/").at(-1);
    const installs = Math.max(0, ...previous.filter((item) => [entry.name, folderName].includes(item.skillName)).map((item) => item.installsCount || 0));
    return {
      ...existing, skillKey, ownerKey: "google", sourceOwnerKeys: ["google"], repoKey: REPO_KEY,
      skillName: entry.name, displayName: entry.name, description: entry.description,
      sources: unique([...(existing?.sources || []), "github"]),
      sourceUrls: unique([`${REPO_URL}/tree/main/${entry.skillPath}`, ...(existing?.sourceUrls || []), INDEX_URL]),
      sourcePath: `${entry.skillPath}/SKILL.md`, installCommand: `npx skills add google/skills --skill ${entry.name}`,
      installsCount: installs, confidence: "high", firstSeenAt: existing?.firstSeenAt || now, lastSeenAt: now
    };
  });
  directory.officialSkills = [...directory.officialSkills.filter((item) => item.repoKey !== REPO_KEY), ...skills];
  repo.skillsCount = skills.length;
  repo.installsCount = skills.reduce((total, skill) => total + skill.installsCount, 0);
  owner.skillsCount = directory.officialSkills.filter((item) => item.ownerKey === "google").length;
  const ownerRepos = directory.officialRepos.filter((item) => item.ownerKey === "google");
  owner.reposCount = ownerRepos.length;
  owner.installsCount = ownerRepos.reduce((total, item) => total + (item.installsCount || 0), 0);
  directory.officialOwners.sort((a, b) => a.ownerKey.localeCompare(b.ownerKey));
  directory.officialRepos.sort((a, b) => a.repoKey.localeCompare(b.repoKey));
  directory.officialSkills.sort((a, b) => a.skillKey.localeCompare(b.skillKey));
  directory.stats ||= {};
  for (const [key, records] of [["Owners", directory.officialOwners], ["Repos", directory.officialRepos], ["Skills", directory.officialSkills]]) {
    directory.stats[key.toLowerCase()] = records.length;
    const counts = {};
    for (const record of records) for (const source of record.sources || []) counts[source] = (counts[source] || 0) + 1;
    directory.stats[`source${key}`] = counts;
  }
  directory.generatedAt = now;
  return skills.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dataPath = process.env.OFFICIAL_SKILLS_OUTPUT || path.join(root, "docs/data/official-skills-universal.json");
  const response = await fetch(INDEX_URL, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Google skill index returned HTTP ${response.status}`);
  const index = await response.json();
  const directory = JSON.parse(await fs.readFile(dataPath, "utf8"));
  const count = importGoogleSkills(directory, index);
  await fs.writeFile(dataPath, JSON.stringify(directory, null, 2) + "\n");
  console.log(`Google: imported ${count} canonical skills from ${REPO_KEY}`);
}
