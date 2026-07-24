import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OWNER_METADATA } from "../docs/lib/owner-metadata.js";
import { computePopularityScore } from "../docs/lib/ranking.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const args = parseArgs(process.argv.slice(2));
const DATA_PATH = path.resolve(
  args.data || path.join(ROOT_DIR, "docs/data/official-skills-universal.json")
);
const SITE_ROOT = path.resolve(
  args.siteRoot || process.env.PAGES_OUTPUT_DIR || path.join(ROOT_DIR, ".pages-dist")
);
const OUTPUT_DIR = path.join(SITE_ROOT, "official");
const VENDOR_DATA_DIR = path.join(SITE_ROOT, "data/vendors");
const SKILLS_PER_PAGE = 100;

const VENDOR_BIOS = {
  anthropics: "Anthropic builds Claude and developer tools for working with AI agents, models, and agent skills.",
  cloudflare: "Cloudflare provides internet infrastructure for deploying, securing, and scaling web applications.",
  expo: "Expo provides tools and services for building React Native apps across iOS, Android, and web.",
  firebase: "Firebase is Google's app development platform for building, shipping, and operating web and mobile apps.",
  figma: "Figma is a collaborative design platform for interface design, prototyping, and product workflows.",
  firecrawl: "Firecrawl provides web crawling and extraction tools for turning websites into structured data.",
  flutter: "Flutter is Google's open-source UI toolkit for building apps across mobile, web, and desktop.",
  github: "GitHub is a developer platform for hosting code, collaborating on repositories, and automating software workflows.",
  getsentry: "Sentry helps software teams monitor errors, performance issues, and production problems in applications.",
  makenotion: "Notion is a connected workspace for notes, docs, projects, databases, and team knowledge.",
  microsoft: "Microsoft builds developer platforms, cloud services, productivity software, and AI tools.",
  openai: "OpenAI builds AI models, agent tools, APIs, and developer products for building with AI.",
  prisma: "Prisma builds database tooling for application developers working with typed data access and schema workflows.",
  shopify: "Shopify is a commerce platform for building online stores, payments, apps, and merchant workflows.",
  stripe: "Stripe provides payments and financial infrastructure for internet businesses.",
  supabase: "Supabase is an open-source backend platform with Postgres, auth, storage, realtime, and edge functions.",
  vercel: "Vercel is a frontend cloud platform for building, previewing, and deploying web applications.",
  "vercel-labs": "Vercel Labs publishes experimental tools and examples for modern web and AI application development."
};

const GITHUB_ICON = `
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-1.04-.01-1.88-2.78.62-3.37-1.21-3.37-1.21-.45-1.19-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.36-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.31.1-2.71 0 0 .84-.28 2.75 1.05A9.28 9.28 0 0 1 12 7.02c.85 0 1.7.12 2.5.34 1.9-1.33 2.74-1.05 2.74-1.05.55 1.4.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.79-4.57 5.05.36.32.68.94.68 1.9 0 1.36-.01 2.46-.01 2.79 0 .27.18.59.69.49A10.15 10.15 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z"></path>
  </svg>`;

const COPY_ICON = `
  <svg class="copy-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
    <rect x="6.5" y="6.5" width="9" height="9" rx="1.8"></rect>
    <path d="M4 13.5H3.8A1.8 1.8 0 0 1 2 11.7V3.8A1.8 1.8 0 0 1 3.8 2h7.9a1.8 1.8 0 0 1 1.8 1.8V4"></path>
  </svg>
  <svg class="copy-check" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true">
    <path d="m4 10.2 3.4 3.4L16 5.8"></path>
  </svg>`;

const EXTERNAL_ICON = `
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
    <path d="M7 4H4.8A1.8 1.8 0 0 0 3 5.8v9.4A1.8 1.8 0 0 0 4.8 17h9.4a1.8 1.8 0 0 0 1.8-1.8V13"></path>
    <path d="M11 3h6v6M9 11l8-8"></path>
  </svg>`;

const SIMPLE_COPY_ICON = `
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
    <rect x="6.5" y="6.5" width="9" height="9" rx="1.8"></rect>
    <path d="M4 13.5H3.8A1.8 1.8 0 0 1 2 11.7V3.8A1.8 1.8 0 0 1 3.8 2h7.9a1.8 1.8 0 0 1 1.8 1.8V4"></path>
  </svg>`;

const rawData = await fs.readFile(DATA_PATH, "utf8");
const data = JSON.parse(rawData);
const owners = [...data.officialOwners]
  .filter((owner) => /^[a-z0-9][a-z0-9._-]*$/i.test(owner.ownerKey || ""))
  .map((owner) => ({ ...owner, rankScore: computeOwnerRankScore(owner) }))
  .sort(
    (left, right) =>
      right.rankScore - left.rankScore ||
      String(left.displayName || left.ownerKey).localeCompare(
        String(right.displayName || right.ownerKey)
      )
  );
const selectedOwners = args.limit ? owners.slice(0, Number(args.limit)) : owners;
const reposByOwner = groupBy(data.officialRepos, "ownerKey");
const skillsByOwner = groupBy(data.officialSkills, "ownerKey");
const sitemapUrls = [];

await fs.mkdir(OUTPUT_DIR, { recursive: true });
await fs.mkdir(VENDOR_DATA_DIR, { recursive: true });

for (const [position, owner] of selectedOwners.entries()) {
  const model = buildVendorModel(
    owner,
    position + 1,
    reposByOwner.get(owner.ownerKey) || [],
    skillsByOwner.get(owner.ownerKey) || []
  );
  if (!model.skills.length) continue;

  const pageDir = path.join(OUTPUT_DIR, owner.ownerKey);
  await fs.mkdir(pageDir, { recursive: true });
  const entries = flattenSkills(model.packs);
  const pageCount = Math.max(1, Math.ceil(entries.length / SKILLS_PER_PAGE));

  await fs.writeFile(
    path.join(VENDOR_DATA_DIR, `${owner.ownerKey}.json`),
    JSON.stringify(renderVendorSearchData(model, entries)),
    "utf8"
  );

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const start = (pageNumber - 1) * SKILLS_PER_PAGE;
    const pageEntries = entries.slice(start, start + SKILLS_PER_PAGE);
    const pagePacks = groupPageEntries(pageEntries);
    const outputPath =
      pageNumber === 1
        ? path.join(pageDir, "index.html")
        : path.join(pageDir, "page", String(pageNumber), "index.html");
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(
      outputPath,
      renderVendorPage(model, {
        pageNumber,
        pageCount,
        pagePacks,
        startIndex: start
      }),
      "utf8"
    );
    sitemapUrls.push(
      pageNumber === 1
        ? `https://skillscout.sh/official/${owner.ownerKey}/`
        : `https://skillscout.sh/official/${owner.ownerKey}/page/${pageNumber}/`
    );
  }
}

await writeVendorSitemap(sitemapUrls, data.generatedAt);

console.log(
  `Generated ${selectedOwners.length} vendor pages and ${sitemapUrls.length} crawlable URLs in ${OUTPUT_DIR}`
);

function buildVendorModel(owner, popularityPosition, ownerRepos, ownerSkills) {
  const [displayName, websiteCandidate] =
    OWNER_METADATA[owner.ownerKey] || [
      prettifyName(owner.displayName || owner.ownerKey),
      owner.website || `https://github.com/${owner.ownerKey}`
    ];
  const fallbackGithubUrl = `https://github.com/${owner.ownerKey}`;
  const website = safeHttpUrl(websiteCandidate, fallbackGithubUrl);
  const githubUrl = safeHttpUrl(owner.githubUrl, fallbackGithubUrl);
  const logoUrl = safeHttpUrl(
    owner.logoUrl ||
      owner.avatarUrl ||
      `https://github.com/${encodeURIComponent(owner.githubLogin || owner.ownerKey)}.png?size=160`,
    "https://skillscout.sh/assets/skillscout-mark-48.png"
  );
  const { packs, repoAliases } = buildPacks(ownerRepos, ownerSkills);
  const readmeRepo = selectReadmeRepo(packs);

  return {
    ...owner,
    displayName,
    website,
    websiteHost: safeHostname(website),
    githubUrl,
    logoUrl,
    vendorBio: createVendorBio(owner, displayName),
    popularityPosition,
    packs,
    repoAliases,
    skills: ownerSkills,
    readmeRepo
  };
}

function buildPacks(repos, skills) {
  const groups = new Map();
  const repoAliases = new Map();

  for (const repo of repos) {
    const installRepo = normalizeRepoKey(repo.canonicalRepoKey || repo.repoKey);
    const rawRepo = normalizeRepoKey(repo.repoKey);
    repoAliases.set(rawRepo.toLowerCase(), installRepo);
    const key = installRepo.toLowerCase();
    const current = groups.get(key);
    if (!current) {
      groups.set(key, {
        installRepo,
        repo,
        aliases: new Set([rawRepo]),
        installsCount: Number(repo.installsCount || 0),
        starsCount: Number(repo.starsCount || 0),
        skills: []
      });
      continue;
    }

    current.aliases.add(rawRepo);
    current.installsCount = Math.max(
      current.installsCount,
      Number(repo.installsCount || 0)
    );
    current.starsCount = Math.max(
      current.starsCount,
      Number(repo.starsCount || 0)
    );
    if (
      Number(repo.installsCount || 0) > Number(current.repo.installsCount || 0)
    ) {
      current.repo = repo;
    }
  }

  for (const skill of skills) {
    const rawRepo = normalizeRepoKey(skill.repoKey);
    const installRepo =
      repoAliases.get(rawRepo.toLowerCase()) || rawRepo || skill.repoKey;
    const key = installRepo.toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, {
        installRepo,
        repo: {
          repoKey: rawRepo,
          repoName: rawRepo.split("/").pop(),
          displayName: rawRepo,
          installsCount: 0,
          starsCount: 0
        },
        aliases: new Set([rawRepo]),
        installsCount: 0,
        starsCount: 0,
        skills: []
      });
    }
    groups.get(key).skills.push(skill);
  }

  const packs = [...groups.values()]
    .map((pack) => ({
      ...pack,
      aliases: [...pack.aliases],
      skills: dedupeSkills(pack.skills).sort(
        (left, right) =>
          Number(right.installsCount || 0) - Number(left.installsCount || 0) ||
          String(left.displayName || left.skillName).localeCompare(
            String(right.displayName || right.skillName)
          )
      )
    }))
    .sort(
      (left, right) =>
        right.installsCount - left.installsCount ||
        right.skills.length - left.skills.length ||
        left.installRepo.localeCompare(right.installRepo)
    );

  return { packs, repoAliases };
}

function dedupeSkills(skills) {
  const unique = new Map();
  for (const skill of skills) {
    const key = String(
      skill.skillKey ||
        `${normalizeRepoKey(skill.repoKey)}:${skill.skillName}`
    ).toLowerCase();
    const current = unique.get(key);
    if (
      !current ||
      Number(skill.installsCount || 0) > Number(current.installsCount || 0)
    ) {
      unique.set(key, skill);
    }
  }
  return [...unique.values()];
}

function selectReadmeRepo(packs) {
  const namedPacks = packs.filter((pack) =>
    /(skills?|plugins?|awesome-copilot|agent-plugins)/i.test(
      pack.repo.repoName || pack.installRepo
    )
  );
  return (namedPacks.length ? namedPacks : packs)[0] || null;
}

function renderVendorPage(
  model,
  { pageNumber, pageCount, pagePacks, startIndex }
) {
  const campaign = `official_vendor_${model.ownerKey}`;
  const repoCount = model.packs.length;
  const skillCount = model.skillsCount || model.skills.length;
  const prompt = `Open https://skillscout.sh/official/${model.ownerKey}/ and review the official ${model.displayName} skills. Recommend the relevant skills for my project, then install the packages I approve with the npx commands on the page.`;
  const isFirstPage = pageNumber === 1;
  const pageSuffix = isFirstPage ? "" : ` - Page ${pageNumber}`;
  const pageTitle = createPageTitle(model.displayName, pageSuffix);
  const canonicalUrl = isFirstPage
    ? `https://skillscout.sh/official/${model.ownerKey}/`
    : `https://skillscout.sh/official/${model.ownerKey}/page/${pageNumber}/`;
  const visibleSkillCount = pagePacks.reduce(
    (total, pack) => total + pack.skills.length,
    0
  );
  const visibleEnd = startIndex + visibleSkillCount;
  const resultLabel =
    pageCount === 1
      ? `${formatNumber(skillCount)} skills`
      : `${formatNumber(startIndex + 1)}-${formatNumber(visibleEnd)} of ${formatNumber(skillCount)} skills`;
  const structuredData = renderStructuredData(model, canonicalUrl, pageNumber);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="index, follow" />
    <title>${escapeHtml(pageTitle)}</title>
    <meta name="description" content="Browse official ${escapeAttr(model.displayName)} AI agent skills, repositories, install commands, and source links." />
    <meta name="referrer" content="strict-origin-when-cross-origin" />
    <link rel="canonical" href="${escapeAttr(canonicalUrl)}" />
    ${pageNumber > 1 ? `<link rel="prev" href="${escapeAttr(getVendorPageUrl(model.ownerKey, pageNumber - 1))}" />` : ""}
    ${pageNumber < pageCount ? `<link rel="next" href="${escapeAttr(getVendorPageUrl(model.ownerKey, pageNumber + 1))}" />` : ""}
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Skillscout" />
    <meta property="og:title" content="${escapeAttr(pageTitle)}" />
    <meta property="og:description" content="Official ${escapeAttr(model.displayName)} skills, install commands, and source repositories." />
    <meta property="og:url" content="${escapeAttr(canonicalUrl)}" />
    <meta property="og:image" content="${escapeAttr(model.logoUrl)}" />
    <meta property="og:image:alt" content="${escapeAttr(model.displayName)} logo" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${escapeAttr(pageTitle)}" />
    <meta name="twitter:description" content="Official ${escapeAttr(model.displayName)} skills, install commands, and source repositories." />
    <meta name="twitter:image" content="${escapeAttr(model.logoUrl)}" />
    <script defer src="/assets/telemetrydeck-events.js?v=20260723-3"></script>
    <link rel="stylesheet" href="/assets/site-shell.css?v=20260724-official-sparkle" />
    <link rel="stylesheet" href="/official/vendor-page.css?v=20260724-vendor-mobile-title-fix" />
    <script src="/assets/site-shell.js?v=20260724-1"></script>
    <script src="/assets/posthog-init.js"></script>
    <link rel="icon" href="/assets/skillscout-mark-48.png" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet" />
    <script type="application/ld+json">${structuredData}</script>
  </head>
  <body>
    ${renderHeader()}
    <main class="vendor-page">
      <nav class="vendor-breadcrumbs" aria-label="Breadcrumb">
        <a href="/">Home</a>
        ${renderChevron()}
        <a href="/official/">Official skills</a>
        ${renderChevron()}
        <span>${escapeHtml(model.displayName)}</span>
        ${isFirstPage ? "" : `${renderChevron()}<span>Page ${pageNumber}</span>`}
      </nav>

      <section class="vendor-hero" aria-labelledby="vendorTitle">
        <div class="vendor-identity">
          <div class="vendor-logo">
            <img src="${escapeAttr(model.logoUrl)}" alt="${escapeAttr(model.displayName)} logo" width="128" height="128" />
          </div>
          <div>
            <div class="vendor-eyebrow">
              <span class="vendor-label">Official skills publisher</span>
              <span class="vendor-verified">
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <circle cx="10" cy="10" r="9" fill="currentColor" opacity="0.14"></circle>
                  <path d="m6 10.2 2.4 2.4 5.6-5.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
                </svg>
                Verified
              </span>
              <span class="vendor-rank" title="Popularity score based on installs and GitHub stars">
                Skillscout rank ${formatNumber(model.rankScore)}
              </span>
              ${isFirstPage ? "" : `<span class="vendor-rank">Page ${pageNumber} of ${pageCount}</span>`}
            </div>
            <h1 class="vendor-title" id="vendorTitle">${escapeHtml(model.displayName)}</h1>
            <p class="vendor-description">${escapeHtml(model.vendorBio)}</p>
            <p class="vendor-description">Browse ${formatNumber(skillCount)} official AI agent ${pluralize(skillCount, "skill", "skills")} across ${formatNumber(model.reposCount || repoCount)} ${escapeHtml(model.displayName)} ${pluralize(model.reposCount || repoCount, "repository", "repositories")}, with install commands and source links.</p>
          </div>
          <div class="vendor-actions">
            <a class="vendor-action" href="${escapeAttr(addUtm(model.website, campaign))}" target="_blank" rel="noopener noreferrer">
              ${renderWebsiteIcon()}
              ${escapeHtml(model.websiteHost)}
            </a>
            <a class="vendor-action" href="${escapeAttr(addUtm(model.githubUrl, campaign))}" target="_blank" rel="noopener noreferrer">
              ${GITHUB_ICON}
              GitHub
            </a>
          </div>
        </div>
        <div class="vendor-metrics" aria-label="${escapeAttr(model.displayName)} skills metrics">
          ${renderMetric(skillCount, pluralize(skillCount, "Skill", "Skills"))}
          ${renderMetric(model.reposCount || repoCount, pluralize(model.reposCount || repoCount, "Repository", "Repositories"))}
          ${renderMetric(model.installsCount || 0, "Installs")}
          ${renderMetric(model.starsCount || 0, "GitHub stars")}
        </div>
      </section>

      ${isFirstPage ? `<section class="vendor-section" aria-labelledby="installTitle">
        <div class="vendor-section-header">
          <div>
            <p class="vendor-section-kicker">Install</p>
            <h2 class="vendor-section-title" id="installTitle">Add ${escapeHtml(model.displayName)} skills to your agent</h2>
            <p class="vendor-section-copy">Copy a package command below or give this prompt to an agent that can install skills.</p>
          </div>
        </div>
        <article class="vendor-install-card prompt-card vendor-prompt-wide">
          <div class="install-card-heading">
            <h3 class="install-card-title">Ask your agent</h3>
            <span class="install-card-badge">Prompt</span>
          </div>
          <div class="copy-block is-prompt">
            <p id="installPrompt">${escapeHtml(prompt)}</p>
            ${renderCopyButton({
              target: "installPrompt",
              label: "Copy agent prompt",
              message: "Prompt copied"
            })}
          </div>
        </article>
      </section>` : ""}

      ${isFirstPage ? `<section class="vendor-section" aria-labelledby="packsTitle">
        <div class="vendor-section-header">
          <div>
            <p class="vendor-section-kicker">Skills packages</p>
            <h2 class="vendor-section-title" id="packsTitle">${formatNumber(repoCount)} official ${pluralize(repoCount, "repository", "repositories")}</h2>
          </div>
        </div>
        <div class="pack-list">
          ${model.packs
            .map((pack, index) => renderPack(pack, index, campaign))
            .join("\n")}
        </div>
      </section>` : ""}

      <section class="vendor-section" aria-labelledby="skillsTitle">
        <div class="vendor-section-header vendor-section-header-search">
          <div>
            <p class="vendor-section-kicker">Individual skills</p>
            <h2 class="vendor-section-title" id="skillsTitle">${formatNumber(skillCount)} skills from ${escapeHtml(model.displayName)}</h2>
          </div>
          <label class="skills-search">
            <span class="sr-only">Search ${escapeHtml(model.displayName)} skills</span>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
              <circle cx="8.5" cy="8.5" r="5.5"></circle>
              <path d="m12.5 12.5 4 4"></path>
            </svg>
            <input id="skillSearch" type="search" placeholder="Search ${escapeAttr(model.displayName)} skills" autocomplete="off" />
          </label>
        </div>
        <p class="skills-result-count" id="skillsResultCount" aria-live="polite">${resultLabel}</p>
        <div
          class="skill-groups"
          id="skillGroups"
          data-vendor-data-url="/data/vendors/${escapeAttr(model.ownerKey)}.json"
          data-search-campaign="${escapeAttr(campaign)}"
          data-total-skills="${skillCount}"
        >
          ${pagePacks
            .map((pack, index) => renderSkillGroup(pack, index, campaign))
            .join("\n")}
        </div>
        <div class="skills-empty" id="skillsEmpty" hidden>No skills match this search.</div>
        ${renderPagination(model.ownerKey, pageNumber, pageCount)}
      </section>

      ${isFirstPage ? renderReadme(model, campaign) : ""}
    </main>
    <div class="copy-status" id="copyStatus" role="status" aria-live="polite">Copied</div>
    <script src="/official/vendor-page.js?v=20260724-1"></script>
  </body>
</html>
`;
}

function renderPack(pack, index, campaign) {
  const commandId = `packInstallCommand${index + 1}`;
  const repoUrl = `https://github.com/${pack.installRepo}`;
  return `<article class="pack-card">
    <div>
      <div class="pack-title-row">
        <span class="pack-icon">${GITHUB_ICON}</span>
        <div>
          <h3 class="pack-title">${escapeHtml(prettifyRepoName(pack.repo.repoName || pack.installRepo))}</h3>
          <a class="pack-link" href="${escapeAttr(addUtm(repoUrl, campaign))}" target="_blank" rel="noopener noreferrer">${escapeHtml(pack.installRepo)}</a>
        </div>
      </div>
      <p class="pack-description">${formatNumber(pack.skills.length)} cataloged ${pluralize(pack.skills.length, "skill", "skills")} from this repository.</p>
      <div class="pack-meta">
        <span>${formatNumber(pack.skills.length)} ${pluralize(pack.skills.length, "skill", "skills")}</span>
        <span>${formatNumber(pack.installsCount)} installs</span>
        <span>${formatNumber(pack.starsCount)} stars</span>
      </div>
    </div>
    <div class="pack-command">
      <div class="copy-block">
        <code id="${commandId}">npx skills add ${escapeHtml(pack.installRepo)} -y</code>
        ${renderCopyButton({
          target: commandId,
          label: `Copy ${pack.installRepo} install command`,
          message: "Package command copied"
        })}
      </div>
    </div>
  </article>`;
}

function renderSkillGroup(pack, index, campaign) {
  return `<details class="skill-group" data-skill-group ${index === 0 ? "open" : ""}>
    <summary>
      <span>
        <strong>${escapeHtml(pack.installRepo)}</strong>
        <small>${formatNumber(pack.skills.length)} ${pluralize(pack.skills.length, "skill", "skills")}</small>
      </span>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <path d="m4 6 4 4 4-4"></path>
      </svg>
    </summary>
    <div class="skills-list">
      ${pack.skills
        .map((skill) => renderSkill(skill, pack, campaign))
        .join("\n")}
    </div>
  </details>`;
}

function renderSkill(skill, pack, campaign) {
  const displayName = skill.displayName || skill.skillName;
  const description = String(skill.description || "").trim();
  const sourceUrl = getSkillSourceUrl(skill, pack.installRepo);
  const command = `npx skills add ${pack.installRepo}@${skill.skillName} -y`;
  const searchText = [
    displayName,
    skill.skillName,
    description,
    pack.installRepo
  ]
    .join(" ")
    .toLowerCase();

  return `<article class="skill-card" data-skill-card data-search="${escapeAttr(searchText)}">
    <div>
      <h3 class="skill-name">${escapeHtml(displayName)}</h3>
      ${description ? `<p class="skill-description">${escapeHtml(description)}</p>` : ""}
      <div class="skill-meta">
        <span>${escapeHtml(pack.installRepo)}</span>
        <span>${formatNumber(skill.installsCount || 0)} installs</span>
      </div>
    </div>
    <div class="skill-actions">
      <a class="skill-link" href="${escapeAttr(addUtm(sourceUrl, campaign))}" target="_blank" rel="noopener noreferrer">
        ${EXTERNAL_ICON}
        View source
      </a>
      <button class="skill-copy" type="button" data-copy-value="${escapeAttr(command)}" data-copy-message="Skill command copied">
        ${SIMPLE_COPY_ICON}
        Copy install
      </button>
    </div>
  </article>`;
}

function renderReadme(model, campaign) {
  if (!model.readmeRepo) return "";
  const repoKey = model.readmeRepo.installRepo;

  return `<section class="vendor-section" aria-labelledby="readmeTitle">
    <div class="vendor-section-header">
      <div>
        <p class="vendor-section-kicker">Repository documentation</p>
        <h2 class="vendor-section-title" id="readmeTitle">Package README</h2>
      </div>
    </div>
    <article class="readme-shell">
      <div class="readme-topbar">
        <span class="readme-file">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
            <path d="M5 2.5h6l4 4v11H5z"></path>
            <path d="M11 2.5v4h4M7.5 11h5M7.5 14h5"></path>
          </svg>
          ${escapeHtml(repoKey)}/README.md
        </span>
        <a class="readme-source" href="${escapeAttr(addUtm(`https://github.com/${repoKey}#readme`, campaign))}" target="_blank" rel="noopener noreferrer">View on GitHub</a>
      </div>
      <div class="readme-content readme-link-content">
        <p>Open the repository README for package documentation, setup instructions, and usage examples.</p>
        <a class="readme-primary-link" href="${escapeAttr(addUtm(`https://github.com/${repoKey}#readme`, campaign))}" target="_blank" rel="noopener noreferrer">
          ${GITHUB_ICON}
          Read ${escapeHtml(repoKey)} README
        </a>
      </div>
    </article>
  </section>`;
}

function renderPagination(ownerKey, pageNumber, pageCount) {
  if (pageCount <= 1) return "";

  const items = getPaginationItems(pageNumber, pageCount)
    .map((item) => {
      if (item === "ellipsis") {
        return `<span class="pagination-ellipsis" aria-hidden="true">...</span>`;
      }
      const current = item === pageNumber;
      return `<a class="pagination-page${current ? " is-current" : ""}" href="${escapeAttr(getVendorPagePath(ownerKey, item))}"${current ? ' aria-current="page"' : ""}>${item}</a>`;
    })
    .join("");

  return `<nav class="vendor-pagination" aria-label="Skills pages">
    <a class="pagination-direction${pageNumber === 1 ? " is-disabled" : ""}" href="${escapeAttr(getVendorPagePath(ownerKey, Math.max(1, pageNumber - 1)))}"${pageNumber === 1 ? ' aria-disabled="true" tabindex="-1"' : ""}>Previous</a>
    <div class="pagination-pages">${items}</div>
    <a class="pagination-direction${pageNumber === pageCount ? " is-disabled" : ""}" href="${escapeAttr(getVendorPagePath(ownerKey, Math.min(pageCount, pageNumber + 1)))}"${pageNumber === pageCount ? ' aria-disabled="true" tabindex="-1"' : ""}>Next</a>
  </nav>`;
}

function getPaginationItems(current, total) {
  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }

  const pages = new Set([1, total, current - 1, current, current + 1]);
  if (current <= 3) {
    pages.add(2);
    pages.add(3);
    pages.add(4);
  }
  if (current >= total - 2) {
    pages.add(total - 1);
    pages.add(total - 2);
    pages.add(total - 3);
  }

  const sorted = [...pages]
    .filter((page) => page >= 1 && page <= total)
    .sort((left, right) => left - right);
  const result = [];
  for (const page of sorted) {
    const previous = result[result.length - 1];
    if (typeof previous === "number" && page - previous > 1) {
      result.push("ellipsis");
    }
    result.push(page);
  }
  return result;
}

function getVendorPagePath(ownerKey, pageNumber) {
  return pageNumber === 1
    ? `/official/${ownerKey}/`
    : `/official/${ownerKey}/page/${pageNumber}/`;
}

function getVendorPageUrl(ownerKey, pageNumber) {
  return `https://skillscout.sh${getVendorPagePath(ownerKey, pageNumber)}`;
}

function renderStructuredData(model, canonicalUrl, pageNumber) {
  return JSON.stringify([
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "Home",
          item: "https://skillscout.sh/"
        },
        {
          "@type": "ListItem",
          position: 2,
          name: "Official skills",
          item: "https://skillscout.sh/official/"
        },
        {
          "@type": "ListItem",
          position: 3,
          name: `${model.displayName}${pageNumber > 1 ? ` - Page ${pageNumber}` : ""}`,
          item: canonicalUrl
        }
      ]
    },
    {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: `${model.displayName} AI Agent Skills`,
      url: canonicalUrl,
      description: `Official ${model.displayName} AI agent skills, install commands, and source repositories.`,
      numberOfItems: Number(model.skillsCount || model.skills.length),
      isPartOf: {
        "@type": "WebSite",
        name: "Skillscout",
        url: "https://skillscout.sh/"
      },
      about: {
        "@type": "Organization",
        name: model.displayName,
        url: model.website
      }
    }
  ]).replaceAll("<", "\\u003c");
}

function flattenSkills(packs) {
  return packs.flatMap((pack) =>
    pack.skills.map((skill) => ({ pack, skill }))
  );
}

function groupPageEntries(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.pack.installRepo.toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, { ...entry.pack, skills: [] });
    }
    groups.get(key).skills.push(entry.skill);
  }
  return [...groups.values()];
}

function renderVendorSearchData(model, entries) {
  return {
    ownerKey: model.ownerKey,
    displayName: model.displayName,
    skills: entries.map(({ pack, skill }) => ({
      displayName: skill.displayName || skill.skillName,
      skillName: skill.skillName,
      description: String(skill.description || "").trim(),
      installsCount: Number(skill.installsCount || 0),
      installRepo: pack.installRepo,
      sourceUrl: getSkillSourceUrl(skill, pack.installRepo)
    }))
  };
}

function getSkillSourceUrl(skill, installRepo) {
  const candidates = [
    skill.sourceUrls?.find((url) => url.includes("github.com")),
    skill.sourceUrls?.find((url) => url.includes("skills.sh")),
    ...(skill.sourceUrls || [])
  ];
  return (
    candidates
      .map((url) => safeHttpUrl(url, ""))
      .find(Boolean) || `https://github.com/${installRepo}`
  );
}

function renderHeader() {
  return `<header class="site-nav-wrap" id="articleNavWrap">
    <div class="site-nav-container">
      <nav class="site-nav" aria-label="Primary navigation">
        <a class="site-brand" href="/">
          <span class="site-brand-mark"><img src="/assets/skillscout-mark-48.png" alt="Skillscout logo" /></span>
          <span class="site-brand-name">Skillscout</span>
        </a>
        <div class="site-nav-links">
          <a href="/#need">Do I need it</a>
          <a href="/#use-cases">Use cases</a>
          <a href="/guides/">Guides</a>
          <a href="/#testimonials">Reviews</a>
          <a href="/#faq">FAQ</a>
          <a class="official-nav-link" href="/official/"><span>Official skills</span><svg class="official-nav-sparkle" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.1 3.8 3.4 1.2-3.4 1.2L8 11.5 6.9 7.7 3.5 6.5l3.4-1.2L8 1.5Z" fill="currentColor"/><path d="M12.5 9.5l.45 1.55 1.55.45-1.55.45-.45 1.55-.45-1.55-1.55-.45 1.55-.45.45-1.55Z" fill="currentColor"/></svg></a>
        </div>
        <div class="site-nav-cta">
          <a class="site-btn" href="https://chromewebstore.google.com/detail/nihcililjolbokbbbmdfhmhbemfefddo?utm_source=site" target="_blank" rel="noopener noreferrer" data-ga-event="extension_click" data-ga-label="vendor-page-nav">Add to Chrome</a>
          <a class="site-btn site-btn-list" href="https://forms.gle/iGfD5tDgTfCE4QX66" target="_blank" rel="noopener noreferrer" data-ga-event="list_skills_click" data-ga-label="vendor-page-nav">
            <span class="site-btn-list-long">List your skills</span>
            <span class="site-btn-list-short">List skill</span>
          </a>
        </div>
        <button class="site-burger" id="articleBurgerBtn" type="button" aria-label="Open navigation" aria-expanded="false" aria-controls="articleMobileMenu">
          <span></span><span></span><span></span>
        </button>
      </nav>
    </div>
    <div class="site-mobile-menu" id="articleMobileMenu">
      <a href="/#need" class="site-mobile-link">Do I need it</a>
      <a href="/#use-cases" class="site-mobile-link">Use cases</a>
      <a href="/guides/" class="site-mobile-link">Guides</a>
      <a href="/#testimonials" class="site-mobile-link">Reviews</a>
      <a href="/#faq" class="site-mobile-link">FAQ</a>
      <a href="/official/" class="site-mobile-link official-nav-link"><span>Official skills</span><svg class="official-nav-sparkle" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.1 3.8 3.4 1.2-3.4 1.2L8 11.5 6.9 7.7 3.5 6.5l3.4-1.2L8 1.5Z" fill="currentColor"/><path d="M12.5 9.5l.45 1.55 1.55.45-1.55.45-.45 1.55-.45-1.55-1.55-.45 1.55-.45.45-1.55Z" fill="currentColor"/></svg></a>
    </div>
  </header>`;
}

function renderMetric(value, label) {
  return `<div class="vendor-metric">
    <span class="vendor-metric-value">${formatNumber(value)}</span>
    <span class="vendor-metric-label">${escapeHtml(label)}</span>
  </div>`;
}

function renderCopyButton({ target, label, message }) {
  return `<button class="copy-button" type="button" aria-label="${escapeAttr(label)}" data-copy-target="${escapeAttr(target)}" data-copy-message="${escapeAttr(message)}">${COPY_ICON}</button>`;
}

function renderChevron() {
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 3 5 5-5 5"></path></svg>`;
}

function renderWebsiteIcon() {
  return `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
    <circle cx="10" cy="10" r="7.5"></circle>
    <path d="M2.8 10h14.4M10 2.5c2 2.1 3 4.6 3 7.5s-1 5.4-3 7.5c-2-2.1-3-4.6-3-7.5s1-5.4 3-7.5Z"></path>
  </svg>`;
}

function computeOwnerRankScore(owner) {
  return Math.round(
    computePopularityScore([
      { kind: "all_time_installs", value: owner.installsCount || 0 },
      { kind: "github_stars", value: owner.starsCount || 0 }
    ]) * 50
  );
}

function normalizeRepoKey(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
}

function prettifyName(value) {
  return String(value || "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function prettifyRepoName(value) {
  return prettifyName(String(value || "").replace(/\.git$/i, ""));
}

function safeHostname(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return String(value || "");
  }
}

function safeHttpUrl(value, fallback) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : fallback;
  } catch {
    return fallback;
  }
}

function createPageTitle(displayName, pageSuffix) {
  const branded = `${displayName} AI Agent Skills${pageSuffix} | Skillscout`;
  if (branded.length <= 60) return branded;

  const unbranded = `${displayName} AI Agent Skills${pageSuffix}`;
  if (unbranded.length <= 60) return unbranded;

  const suffix = ` AI Agent Skills${pageSuffix}`;
  const availableLength = Math.max(12, 60 - suffix.length - 3);
  const shortenedName = truncateAtWord(displayName, availableLength);
  return `${shortenedName}...${suffix}`;
}

function truncateAtWord(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  const shortened = text.slice(0, maxLength + 1);
  const wordBoundary = shortened.lastIndexOf(" ");
  return shortened.slice(0, wordBoundary > maxLength * 0.6 ? wordBoundary : maxLength).trim();
}

function addUtm(value, campaign) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "#";
    }
    url.searchParams.set("utm_source", "skillscout");
    url.searchParams.set("utm_medium", "vendor_page");
    url.searchParams.set("utm_campaign", campaign);
    return url.toString();
  } catch {
    return value;
  }
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function pluralize(value, singular, plural) {
  return Number(value) === 1 ? singular : plural;
}

function createVendorBio(owner, displayName) {
  const curated = VENDOR_BIOS[owner.ownerKey];
  if (curated) return curated;

  const description = cleanVendorDescription(owner.description);
  if (description) return description;

  return `${displayName} publishes official AI agent skills for its tools, services, and developer workflows.`;
}

function cleanVendorDescription(value) {
  const description = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!description) return "";
  const withoutTrailing = description.replace(/[.!?]*$/, "");
  return `${withoutTrailing}.`;
}

function groupBy(items, key) {
  const groups = new Map();
  for (const item of items || []) {
    const value = item[key];
    const group = groups.get(value) || [];
    group.push(item);
    groups.set(value, group);
  }
  return groups;
}

async function writeVendorSitemap(urls, generatedAt) {
  const date = String(generatedAt || new Date().toISOString()).slice(0, 10);
  const vendorSitemap = renderSitemap(urls, date);
  await fs.writeFile(
    path.join(SITE_ROOT, "sitemap-vendors.xml"),
    vendorSitemap,
    "utf8"
  );

  const sitemapPath = path.join(SITE_ROOT, "sitemap.xml");
  const coreSitemapPath = path.join(SITE_ROOT, "sitemap-core.xml");
  let coreSitemap =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n`;
  try {
    const currentSitemap = await fs.readFile(sitemapPath, "utf8");
    if (currentSitemap.includes("<urlset")) {
      coreSitemap = currentSitemap;
    }
  } catch {
  }

  await fs.writeFile(coreSitemapPath, coreSitemap, "utf8");

  const coreUrls = extractSitemapUrls(coreSitemap);
  const allUrls = [...new Set([...coreUrls, ...urls])];
  await fs.writeFile(sitemapPath, renderSitemap(allUrls, date), "utf8");
}

function renderSitemap(urls, date) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (url) => `  <url>
    <loc>${escapeXml(url)}</loc>
    <lastmod>${date}</lastmod>
  </url>`
  )
  .join("\n")}
</urlset>
`;
}

function extractSitemapUrls(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) =>
    unescapeXml(match[1].trim())
  );
}

function unescapeXml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2).replace(/-([a-z])/g, (_, letter) =>
      letter.toUpperCase()
    );
    const next = values[index + 1];
    result[key] = next && !next.startsWith("--") ? next : true;
    if (result[key] !== true) index += 1;
  }
  return result;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("\n", "&#10;");
}
