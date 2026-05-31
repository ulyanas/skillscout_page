import { computePopularityScore } from "../lib/ranking.js";

const DATA_URL = "/data/official-skills-universal.json";
const GITHUB_API_BASE =
  location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? "/preview-proxy/github"
    : "https://api.github.com";
const INITIAL_LIMIT = 48;
const PAGE_SIZE = 48;
const OWNER_SKILL_PREVIEW_LIMIT = 5;
const STARS_CACHE_TTL = 3_600_000; // 1 hour
const STARS_CACHE_PREFIX = "skillscout_stars_v1_";
const MAX_CONCURRENT_STARS_FETCHES = 3;

const OWNER_METADATA = {
  "agentmail-to": ["AgentMail", "https://agentmail.to", "https://github.com/agentmail-to/agentmail-skills"],
  airtable: ["Airtable", "https://www.airtable.com", "https://github.com/airtable/skills"],
  amplitude: ["Amplitude", "https://amplitude.com", "https://github.com/amplitude/builder-skills"],
  anthropics: ["Anthropic", "https://www.anthropic.com"],
  apify: ["Apify", "https://apify.com"],
  apollographql: ["Apollo GraphQL", "https://www.apollographql.com"],
  astronomer: ["Astronomer", "https://www.astronomer.io"],
  atlassian: ["Atlassian", "https://www.atlassian.com", "https://github.com/atlassian"],
  auth0: ["Auth0", "https://auth0.com"],
  automattic: ["Automattic", "https://automattic.com"],
  axiomhq: ["Axiom", "https://axiom.co"],
  azure: ["Azure", "https://azure.microsoft.com", "https://github.com/Azure"],
  base: ["Base", "https://www.base.org"],
  "better-auth": ["Better Auth", "https://www.better-auth.com"],
  binance: ["Binance", "https://www.binance.com", "https://github.com/binance/binance-skills-hub"],
  bitwarden: ["Bitwarden", "https://bitwarden.com"],
  box: ["Box", "https://www.box.com"],
  brave: ["Brave", "https://brave.com"],
  "browser-use": ["Browser Use", "https://browser-use.com"],
  browserbase: ["Browserbase", "https://www.browserbase.com"],
  callstackincubator: ["Callstack", "https://www.callstack.com"],
  canva: ["Canva", "https://www.canva.com", "https://github.com/canva"],
  clerk: ["Clerk", "https://clerk.com"],
  clickhouse: ["ClickHouse", "https://clickhouse.com"],
  cloudflare: ["Cloudflare", "https://www.cloudflare.com"],
  coderabbitai: ["CodeRabbit", "https://www.coderabbit.ai"],
  coinbase: ["Coinbase", "https://www.coinbase.com"],
  contentful: ["Contentful", "https://www.contentful.com"],
  contentstack: ["Contentstack", "https://www.contentstack.com"],
  coveo: ["Coveo", "https://www.coveo.com", "https://github.com/coveo/ui-kit"],
  "convex-dev": ["Convex", "https://www.convex.dev"],
  "dagster-io": ["Dagster", "https://dagster.io"],
  dash0hq: ["Dash0", "https://www.dash0.com"],
  daloopa: ["Daloopa", "https://www.daloopa.com", "https://github.com/daloopa/plugin"],
  "datadog-labs": ["Datadog", "https://www.datadoghq.com"],
  "dbt-labs": ["dbt Labs", "https://www.getdbt.com"],
  deepgram: ["Deepgram", "https://deepgram.com"],
  denoland: ["Deno", "https://deno.com"],
  dovetail: ["Dovetail", "https://dovetail.com", "https://github.com/dovetail/skills"],
  elastic: ["Elastic", "https://www.elastic.co", "https://github.com/elastic/agent-skills"],
  elevenlabs: ["ElevenLabs", "https://elevenlabs.io"],
  encoredev: ["Encore", "https://encore.dev"],
  exploreomni: ["Omni", "https://exploreomni.com"],
  expo: ["Expo", "https://expo.dev"],
  facebook: ["Meta", "https://about.meta.com"],
  "factory-ai": ["Factory", "https://www.factory.ai"],
  figma: ["Figma", "https://www.figma.com"],
  firebase: ["Firebase", "https://firebase.google.com"],
  firecrawl: ["Firecrawl", "https://www.firecrawl.dev"],
  flutter: ["Flutter", "https://flutter.dev"],
  getsentry: ["Sentry", "https://sentry.io"],
  github: ["GitHub", "https://github.com"],
  google: ["Google Workspace", "https://workspace.google.com", "https://github.com/googleworkspace"],
  "google-gemini": ["Google Gemini", "https://gemini.google.com"],
  "google-labs-code": ["Google Labs", "https://labs.google"],
  hashicorp: ["HashiCorp", "https://www.hashicorp.com"],
  huggingface: ["Hugging Face", "https://huggingface.co"],
  kotlin: ["Kotlin", "https://kotlinlang.org"],
  "langchain-ai": ["LangChain", "https://www.langchain.com"],
  langfuse: ["Langfuse", "https://langfuse.com"],
  launchdarkly: ["LaunchDarkly", "https://launchdarkly.com"],
  livekit: ["LiveKit", "https://livekit.io"],
  makenotion: ["Notion", "https://www.notion.com"],
  mapbox: ["Mapbox", "https://www.mapbox.com"],
  "mastra-ai": ["Mastra", "https://mastra.ai"],
  "mcp-use": ["mcp-use", "https://mcp-use.com"],
  medusajs: ["Medusa", "https://medusajs.com"],
  microsoft: ["Microsoft", "https://www.microsoft.com"],
  "n8n-io": ["n8n", "https://n8n.io"],
  neondatabase: ["Neon", "https://neon.tech"],
  nvidia: ["NVIDIA", "https://www.nvidia.com", "https://github.com/NVIDIA/skills"],
  nuxt: ["Nuxt", "https://nuxt.com"],
  openai: ["OpenAI", "https://openai.com"],
  openshift: ["OpenShift", "https://www.redhat.com/en/technologies/cloud-computing/openshift"],
  "parallel-web": ["Parallel", "https://parallel.ai"],
  "pinecone-io": ["Pinecone", "https://www.pinecone.io"],
  pipedrive: ["Pipedrive", "https://www.pipedrive.com", "https://github.com/pipedrive/superpowers"],
  planetscale: ["PlanetScale", "https://planetscale.com"],
  posthog: ["PostHog", "https://posthog.com"],
  pydantic: ["Pydantic", "https://pydantic.dev", "https://github.com/pydantic/skills"],
  prisma: ["Prisma", "https://www.prisma.io"],
  projectopensea: ["OpenSea", "https://opensea.io"],
  pulumi: ["Pulumi", "https://www.pulumi.com"],
  pytorch: ["PyTorch", "https://pytorch.org"],
  redis: ["Redis", "https://redis.io"],
  "remotion-dev": ["Remotion", "https://www.remotion.dev"],
  resend: ["Resend", "https://resend.com"],
  "rivet-dev": ["Rivet", "https://rivet.gg"],
  runwayml: ["Runway", "https://runwayml.com"],
  "sanity-io": ["Sanity", "https://www.sanity.io"],
  semgrep: ["Semgrep", "https://semgrep.dev"],
  shopify: ["Shopify", "https://www.shopify.com"],
  signoz: ["SigNoz", "https://signoz.io"],
  snyk: ["Snyk", "https://snyk.io", "https://github.com/snyk/studio-recipes"],
  streamlit: ["Streamlit", "https://streamlit.io"],
  stripe: ["Stripe", "https://stripe.com"],
  supabase: ["Supabase", "https://supabase.com"],
  sveltejs: ["Svelte", "https://svelte.dev"],
  "tavily-ai": ["Tavily", "https://www.tavily.com"],
  temporalio: ["Temporal", "https://temporal.io"],
  tinybirdco: ["Tinybird", "https://www.tinybird.co"],
  tldraw: ["tldraw", "https://www.tldraw.com"],
  triggerdotdev: ["Trigger.dev", "https://trigger.dev"],
  upstash: ["Upstash", "https://upstash.com"],
  vercel: ["Vercel", "https://vercel.com"],
  "vercel-labs": ["Vercel Labs", "https://vercel.com"],
  webflow: ["Webflow", "https://webflow.com"],
  whopio: ["Whop", "https://whop.com"],
  wix: ["Wix", "https://www.wix.com"],
  wordpress: ["WordPress", "https://wordpress.org"],
  zoom: ["Zoom", "https://www.zoom.com", "https://github.com/zoom/skills"],
  zotero: ["Zotero", "https://www.zotero.org", "https://github.com/zotero/translators"],
  zapier: ["Zapier", "https://zapier.com", "https://github.com/zapier"],
  // GitHub-discovered vendors
  "a5c-ai": ["a5c.ai", "https://a5c.ai"],
  "bitroot-org": ["Bitroot", "https://bitroot.org"],
  cherryhq: ["Cherry Studio", "https://cherry-ai.com"],
  checkly: ["Checkly", "https://checklyhq.com"],
  coldbox: ["ColdBox Platform", "https://www.coldbox.org"],
  "cmu-llab": ["LLab at CMU", "https://llab-cmu.github.io"],
  copilotkit: ["CopilotKit", "https://copilotkit.ai"],
  harmonicabot: ["Harmonica", "https://www.harmonica.chat"],
  ideamans: ["ideaman's Inc.", "https://www.ideamans.com"],
  "ievo-ai": ["iEVO", "https://ievo.ai"],
  "math-inc": ["Math, Inc.", "https://math.inc"],
  "nexu-io": ["nexu", "https://nexu.io"],
  "obot-platform": ["Obot AI", "https://obot.ai"],
  putdotio: ["put.io", "https://put.io"],
  "ranbot-ai": ["RanBOT Labs", "https://ranbot.online"],
  snapchat: ["Snap Inc.", "https://snap.com"],
  swarmclawai: ["SwarmClaw AI", "https://www.swarmclaw.ai"],
  "tech-leads-club": ["TechLeads.club", "https://techleads.club"],
  tencentcloudbase: ["Tencent CloudBase", "https://docs.cloudbase.net"],
  "tophant-ai": ["Tophant", "https://www.tophant.com"]
};

const state = {
  data: null,
  owners: [],
  filteredOwners: [],
  visibleLimit: INITIAL_LIMIT,
  viewMode: "tile",
  query: "",
  sortBy: "rank"
};

// Cache card elements by ownerKey so logos aren't recreated on every render
const cardCache = new Map();

const elements = {
  searchInput: document.querySelector("#searchInput"),
  sortSelect: document.querySelector("#sortSelect"),
  tileViewButton: document.querySelector("#tileViewButton"),
  listViewButton: document.querySelector("#listViewButton"),
  clearButton: document.querySelector("#clearButton"),
  ownersCount: document.querySelector("#ownersCount"),
  reposCount: document.querySelector("#reposCount"),
  skillsCount: document.querySelector("#skillsCount"),
  resultSummary: document.querySelector("#resultSummary"),
  resultsGrid: document.querySelector("#resultsGrid"),
  emptyState: document.querySelector("#emptyState"),
  showMoreButton: document.querySelector("#showMoreButton"),
  template: document.querySelector("#ownerCardTemplate")
};

// ── Custom tooltip ────────────────────────────────────────────────────────────

const tooltipEl = document.createElement("div");
tooltipEl.className = "custom-tooltip";
tooltipEl.setAttribute("role", "tooltip");
document.body.appendChild(tooltipEl);

let tooltipTimer = null;

function showTooltip(text, anchorEl) {
  clearTimeout(tooltipTimer);
  tooltipEl.textContent = text; // set text now so offsetWidth is valid during timeout
  tooltipTimer = setTimeout(() => {
    const rect = anchorEl.getBoundingClientRect();
    const tw = tooltipEl.offsetWidth;
    const left = Math.max(8, Math.min(rect.left + (rect.width - tw) / 2, window.innerWidth - tw - 8));
    tooltipEl.style.left = `${left}px`;
    tooltipEl.style.top = `${rect.bottom + 6}px`;
    tooltipEl.classList.add("visible");
  }, 150);
}

function hideTooltip() {
  clearTimeout(tooltipTimer);
  tooltipEl.classList.remove("visible");
}

// ── Stars fetching ────────────────────────────────────────────────────────────

let starsRateLimited = false;
let starsCurrentlyFetching = 0;
let starsFetchQueue = [];

async function fetchRepoStars(repoKey) {
  if (starsRateLimited || !repoKey) {
    return null;
  }

  const cacheKey = STARS_CACHE_PREFIX + repoKey;
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const { count, fetchedAt } = JSON.parse(cached);
      if (Date.now() - fetchedAt < STARS_CACHE_TTL) {
        return count;
      }
    }
  } catch {}

  try {
    const response = await fetch(`${GITHUB_API_BASE}/repos/${repoKey}`);
    if (response.status === 403 || response.status === 429) {
      starsRateLimited = true;
      return null;
    }
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    const count = data?.stargazers_count ?? null;
    if (count != null) {
      try {
        localStorage.setItem(cacheKey, JSON.stringify({ count, fetchedAt: Date.now() }));
      } catch {}
    }
    return count;
  } catch {
    return null;
  }
}

function processStarsQueue() {
  while (starsCurrentlyFetching < MAX_CONCURRENT_STARS_FETCHES && starsFetchQueue.length > 0) {
    const owner = starsFetchQueue.shift();
    starsCurrentlyFetching++;
    fetchRepoStars(owner.bestRepoKey).then((count) => {
      starsCurrentlyFetching--;
      if (count != null) {
        updateOwnerStars(owner, count);
      }
      processStarsQueue();
    });
  }
}

function queueStarsFetch(owners) {
  // Always re-queue for real-time refresh; localStorage cache prevents redundant GitHub calls
  starsFetchQueue = owners.filter((o) => o.bestRepoKey);
  processStarsQueue();
}

function updateOwnerStars(owner, count) {
  owner.starsCount = count;
  owner.rankScore = computeOwnerRankScore(owner);
  document.querySelectorAll(`.owner-card[data-owner-key="${CSS.escape(owner.ownerKey)}"] .stars-count`).forEach((el) => {
    el.textContent = formatCompactNumber(count);
  });
}

// ── Rank computation ──────────────────────────────────────────────────────────

function computeOwnerRankScore(owner) {
  const metrics = [{ kind: "all_time_installs", value: owner.installsCount || 0 }];
  if (owner.starsCount != null) {
    metrics.push({ kind: "github_stars", value: owner.starsCount });
  }
  return Math.round(computePopularityScore(metrics) * 50);
}

// ── Init ──────────────────────────────────────────────────────────────────────

init();

async function init() {
  bindEvents();
  updateClearButton();

  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Directory request failed with ${response.status}`);
    }

    state.data = await response.json();
    state.owners = buildOwnerGroups(state.data);
    state.filteredOwners = applySort(state.owners);
    renderStats();
    renderResults();
  } catch (error) {
    elements.resultSummary.textContent =
      error instanceof Error ? error.message : "Official directory could not be loaded.";
  }
}

function bindEvents() {
  elements.searchInput.addEventListener("input", () => {
    state.query = elements.searchInput.value.trim();
    state.visibleLimit = INITIAL_LIMIT;
    updateClearButton();
    runSearch();
  });

  elements.clearButton.addEventListener("click", () => {
    elements.searchInput.value = "";
    state.query = "";
    state.visibleLimit = INITIAL_LIMIT;
    updateClearButton();
    runSearch();
    elements.searchInput.focus();
  });

  elements.sortSelect.addEventListener("change", () => {
    state.sortBy = elements.sortSelect.value;
    state.visibleLimit = INITIAL_LIMIT;
    state.filteredOwners = applySort(state.filteredOwners);
    renderResults();
  });

  elements.tileViewButton.addEventListener("click", () => setViewMode("tile"));
  elements.listViewButton.addEventListener("click", () => setViewMode("list"));

  elements.showMoreButton.addEventListener("click", () => {
    state.visibleLimit += PAGE_SIZE;
    renderResults();
  });
}

// ── Data building ─────────────────────────────────────────────────────────────

function buildOwnerGroups(data) {
  const repos = new Map((data.officialRepos || []).map((repo) => [repo.repoKey, repo]));
  const reposByOwner = new Map();
  const skillsByOwner = new Map();

  for (const repo of data.officialRepos || []) {
    const ownerRepos = reposByOwner.get(repo.ownerKey) || [];
    ownerRepos.push(repo);
    reposByOwner.set(repo.ownerKey, ownerRepos);
  }

  for (const skill of data.officialSkills || []) {
    const repo = skill.repoKey ? repos.get(skill.repoKey) : null;
    const enrichedSkill = {
      ...skill,
      repoDisplayName: repo?.displayName || skill.repoKey || "Standalone skill",
      searchText: buildSearchText([
        skill.skillKey,
        skill.skillName,
        skill.displayName,
        skill.description,
        skill.ownerKey,
        skill.repoKey,
        repo?.displayName,
        ...(skill.sources || []),
        ...(skill.sourceOwnerKeys || [])
      ])
    };

    const ownerSkills = skillsByOwner.get(skill.ownerKey) || [];
    ownerSkills.push(enrichedSkill);
    skillsByOwner.set(skill.ownerKey, ownerSkills);
  }

  return (data.officialOwners || []).map((owner) => {
    const skills = (skillsByOwner.get(owner.ownerKey) || []).sort(compareSkills);
    const ownerRepos = reposByOwner.get(owner.ownerKey) || [];
    const bestRepo = [...ownerRepos].sort(compareRepos)[0];
    const metadata = getOwnerMetadata(owner);
    const githubUrl = getOwnerGithubUrl(owner, ownerRepos, metadata);
    const directSearchText = buildSearchText([
      owner.ownerKey,
      metadata.displayName,
      metadata.websiteHost,
      ...(owner.normalizedNames || []),
      ...(owner.sourceOwnerKeys || [])
    ]);
    const searchText = buildSearchText([directSearchText, ...skills.map((skill) => skill.searchText)]);
    const installsKnown = hasKnownInstalls(owner, skills);

    const ownerObj = {
      ...owner,
      displayName: metadata.displayName,
      websiteUrl: metadata.websiteUrl,
      websiteHost: metadata.websiteHost,
      logoUrl: metadata.logoUrl,
      fallbackLogoUrl: metadata.fallbackLogoUrl,
      githubUrl,
      skills,
      matchingSkills: skills,
      directSearchText,
      searchText,
      topSkillNames: skills.slice(0, OWNER_SKILL_PREVIEW_LIMIT).map((skill) => skill.displayName || skill.skillName),
      bestRepoKey: bestRepo?.repoKey || null,
      installsKnown,
      starsCount: typeof owner.starsCount === "number" ? owner.starsCount : null,
      dateAddedMs: parseDateMs(owner.firstSeenAt) || parseDateMs(owner.lastSeenAt)
    };

    ownerObj.rankScore = computeOwnerRankScore(ownerObj);
    return ownerObj;
  });
}

// ── Search ────────────────────────────────────────────────────────────────────

function runSearch() {
  const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);

  const matched = terms.length
    ? state.owners
        .filter((owner) => terms.every((term) => owner.searchText.includes(term)))
        .map((owner) => {
          const matchingSkills = owner.skills.filter((skill) =>
            terms.every((term) => skill.searchText.includes(term))
          );
          return {
            ...owner,
            matchingSkills: matchingSkills.length ? matchingSkills : owner.skills,
            searchScore: scoreOwnerMatch(owner, matchingSkills, terms)
          };
        })
        .sort(compareSearchOwners)
    : state.owners.map((owner) => ({ ...owner, matchingSkills: owner.skills }));

  state.filteredOwners = terms.length && state.sortBy === "rank" ? matched : applySort(matched);
  renderResults();
}

// ── Sorting ───────────────────────────────────────────────────────────────────

function applySort(owners) {
  return [...owners].sort((a, b) => {
    switch (state.sortBy) {
      case "rank":
        return (b.rankScore || 0) - (a.rankScore || 0) || compareByName(a, b);
      case "recent":
        return (
          (b.dateAddedMs || 0) - (a.dateAddedMs || 0) ||
          compareByName(a, b) ||
          (b.rankScore || 0) - (a.rankScore || 0)
        );
      case "skills":
        return (b.skills.length || 0) - (a.skills.length || 0) || compareByName(a, b);
      case "stars":
        return (b.starsCount ?? -1) - (a.starsCount ?? -1) || (b.rankScore || 0) - (a.rankScore || 0);
      case "installs":
        return (
          Number(b.installsKnown) - Number(a.installsKnown) ||
          (b.installsCount || 0) - (a.installsCount || 0) ||
          compareByName(a, b)
        );
      case "repos":
        return (b.reposCount || 0) - (a.reposCount || 0) || compareByName(a, b);
      case "name":
        return compareByName(a, b);
      default:
        return 0;
    }
  });
}

function compareByName(a, b) {
  return String(a.displayName || a.ownerKey).localeCompare(String(b.displayName || b.ownerKey));
}

function parseDateMs(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function renderStats() {
  const { stats } = state.data;
  elements.ownersCount.textContent = formatNumber(stats.owners);
  elements.reposCount.textContent = formatNumber(stats.repos);
  elements.skillsCount.textContent = formatNumber(stats.skills);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderResults() {
  const totalOwners = state.filteredOwners.length;
  const visibleOwners = state.filteredOwners.slice(0, state.visibleLimit);
  const totalMatchingSkills = countMatchingSkills(state.filteredOwners);

  elements.resultsGrid.replaceChildren(...visibleOwners.map((owner, index) => {
    if (!cardCache.has(owner.ownerKey)) {
      cardCache.set(owner.ownerKey, createOwnerCard(owner));
    }
    const card = cardCache.get(owner.ownerKey);
    updateCardSearchContext(card, owner);
    return card;
  }));
  elements.emptyState.classList.toggle("hidden", totalOwners > 0);
  elements.showMoreButton.classList.toggle("hidden", state.visibleLimit >= totalOwners);

  const remaining = Math.max(0, totalOwners - state.visibleLimit);
  elements.showMoreButton.textContent = `Show ${formatNumber(Math.min(PAGE_SIZE, remaining))} more owners`;

  const queryCopy = state.query ? ` for "${state.query}"` : "";
  elements.resultSummary.textContent = `Showing ${formatNumber(visibleOwners.length)} of ${formatNumber(
    totalOwners
  )} owners with ${formatNumber(totalMatchingSkills)} skills${queryCopy}.`;

  queueStarsFetch(visibleOwners);
}

function updateCardSearchContext(card, owner) {
  const previewSkills = getPreviewSkills(owner);
  const totalSkills = owner.matchingSkills.length || owner.skills.length;

  card.querySelector(".match-count").textContent = `${formatNumber(owner.matchingSkills.length)} matching skills`;

  const skillItems = previewSkills.map(createSkillPreviewItem);
  if (totalSkills > OWNER_SKILL_PREVIEW_LIMIT) {
    skillItems.push(createOverflowIndicator(totalSkills - OWNER_SKILL_PREVIEW_LIMIT));
  }
  card.querySelector(".skill-preview").replaceChildren(...skillItems);
}

function createOwnerCard(owner) {
  const fragment = elements.template.content.cloneNode(true);
  const card = fragment.querySelector(".owner-card");
  const logo = card.querySelector(".owner-logo");
  const initial = card.querySelector(".owner-initial");

  card.dataset.href = owner.githubUrl;
  card.dataset.ownerKey = owner.ownerKey;
  card.setAttribute("role", "link");
  card.setAttribute("aria-label", `Open ${owner.displayName} GitHub repository`);
  card.addEventListener("click", (event) => {
    if (event.target.closest("a, button")) {
      return;
    }
    window.open(addUtm(owner.githubUrl), "_blank", "noopener,noreferrer");
  });
  card.addEventListener("keydown", (event) => {
    if (event.target.closest("a, button")) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      window.open(addUtm(owner.githubUrl), "_blank", "noopener,noreferrer");
    }
  });

  initial.textContent = getOwnerInitial(owner.displayName || owner.ownerKey);
  logo.dataset.fallbackLogo = owner.fallbackLogoUrl;
  logo.addEventListener("load", () => {
    logo.classList.add("loaded");
  });
  logo.addEventListener("error", () => {
    if (logo.dataset.fallbackLogo && logo.src !== logo.dataset.fallbackLogo) {
      logo.src = logo.dataset.fallbackLogo;
      return;
    }
    logo.classList.remove("loaded");
  });
  logo.src = owner.logoUrl;

  card.querySelector(".owner-name").textContent = owner.displayName;
  const website = card.querySelector(".owner-website");
  website.href = addUtm(owner.websiteUrl);
  website.textContent = owner.websiteHost;
  card.querySelector(".skills-count").textContent = formatNumber(owner.skills.length || owner.skillsCount || 0);
  card.querySelector(".repos-count").textContent = formatNumber(owner.reposCount || 0);
  card.querySelector(".installs-count").textContent = formatInstallCount(owner);
  card.querySelector(".stars-count").textContent = owner.starsCount != null ? formatCompactNumber(owner.starsCount) : "–";
  const rankBadge = card.querySelector(".rank-badge");
  const grade = getPopularityGrade(owner.rankScore || 0);
  const tooltipText = `Skillscout rank: ${formatNumber(owner.rankScore || 0)}`;
  rankBadge.addEventListener("mouseenter", () => showTooltip(tooltipText, rankBadge));
  rankBadge.addEventListener("mouseleave", hideTooltip);
  rankBadge.appendChild(createSignalSvg(grade));
  const link = card.querySelector(".open-link");
  link.href = addUtm(owner.githubUrl);
  link.setAttribute("aria-label", `Open ${owner.displayName} on GitHub`);

  return card;
}

function getPreviewSkills(owner) {
  const skills = owner.matchingSkills.length ? owner.matchingSkills : owner.skills;
  return skills.slice(0, OWNER_SKILL_PREVIEW_LIMIT);
}

function createSkillPreviewItem(skill) {
  const item = document.createElement("li");
  item.className = "skill-preview-item";

  const name = document.createElement("span");
  name.className = "skill-name";
  name.textContent = skill.displayName || skill.skillName;

  const repo = document.createElement("span");
  repo.textContent = skill.repoDisplayName;

  item.append(name, repo);
  return item;
}

function createOverflowIndicator(remaining) {
  const item = document.createElement("li");
  item.className = "skill-preview-item skill-overflow-item";
  const label = document.createElement("span");
  label.className = "overflow-label";
  label.textContent = `+${remaining} more`;
  item.append(label);
  return item;
}

// ── Signal badge ─────────────────────────────────────────────────────────────

function getPopularityGrade(score) {
  if (score >= 190) return 4;
  if (score >= 160) return 3;
  if (score >= 130) return 2;
  return 1;
}

function createSignalSvg(grade) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 20 14");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");

  const bars = [
    { x: 0,  y: 10, h: 4  },
    { x: 5,  y: 7,  h: 7  },
    { x: 10, y: 3,  h: 11 },
    { x: 15, y: 0,  h: 14 }
  ];

  bars.forEach((bar, i) => {
    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("x", bar.x);
    rect.setAttribute("y", bar.y);
    rect.setAttribute("width", "3.5");
    rect.setAttribute("height", bar.h);
    rect.setAttribute("rx", "0.75");
    rect.setAttribute("class", i < grade ? "signal-bar signal-bar--on" : "signal-bar");
    svg.appendChild(rect);
  });

  return svg;
}

// ── View mode ─────────────────────────────────────────────────────────────────

function setViewMode(viewMode) {
  state.viewMode = viewMode;
  const isTile = viewMode === "tile";

  elements.tileViewButton.classList.toggle("active", isTile);
  elements.listViewButton.classList.toggle("active", !isTile);
  elements.tileViewButton.setAttribute("aria-pressed", String(isTile));
  elements.listViewButton.setAttribute("aria-pressed", String(!isTile));
  elements.resultsGrid.classList.toggle("tile-view", isTile);
  elements.resultsGrid.classList.toggle("list-view", !isTile);
}

function updateClearButton() {
  elements.clearButton.hidden = !elements.searchInput.value.trim();
}

// ── Score/compare helpers ─────────────────────────────────────────────────────

function compareSearchOwners(left, right) {
  const score = Number(right.searchScore || 0) - Number(left.searchScore || 0);
  if (score) {
    return score;
  }
  return (right.rankScore || 0) - (left.rankScore || 0) || compareByName(left, right);
}

function scoreOwnerMatch(owner, matchingSkills, terms) {
  const directMatch = terms.every((term) => owner.directSearchText.includes(term));
  const nameMatch = terms.every((term) =>
    buildSearchText([owner.ownerKey, owner.displayName, ...(owner.sourceOwnerKeys || [])]).includes(term)
  );
  const exactNameMatch = terms.some((term) =>
    [owner.ownerKey, owner.displayName, ...(owner.sourceOwnerKeys || [])]
      .map((value) => String(value || "").toLowerCase())
      .includes(term)
  );

  return (
    Number(exactNameMatch) * 20_000 +
    Number(nameMatch) * 10_000 +
    Number(directMatch) * 5_000 +
    matchingSkills.length * 10 +
    Number(owner.sources?.length || 0)
  );
}

function compareSkills(left, right) {
  const sourceScore = Number((right.sources || []).length) - Number((left.sources || []).length);
  if (sourceScore) {
    return sourceScore;
  }
  const installScore = Number(right.installsCount || 0) - Number(left.installsCount || 0);
  if (installScore) {
    return installScore;
  }
  return String(left.skillKey).localeCompare(String(right.skillKey));
}

function compareRepos(left, right) {
  const installsScore = Number(right.installsCount || 0) - Number(left.installsCount || 0);
  if (installsScore) {
    return installsScore;
  }
  return Number(right.skillsCount || 0) - Number(left.skillsCount || 0);
}

function countMatchingSkills(owners) {
  return owners.reduce((sum, owner) => sum + owner.matchingSkills.length, 0);
}

// ── Metadata helpers ──────────────────────────────────────────────────────────

function getOwnerMetadata(owner) {
  // OWNER_METADATA is the authoritative source for known vendors.
  // For github-discovery vendors not yet in the map, fall back to
  // owner.website from the data file, then to github.com.
  const fallbackWebsite = owner.website || `https://github.com/${owner.sourceOwnerKeys?.[0] || owner.ownerKey}`;
  const [displayName, websiteUrl, githubUrl] = OWNER_METADATA[owner.ownerKey] || [
    prettifyOwnerName(owner.displayName || owner.ownerKey),
    fallbackWebsite,
  ];
  const normalizedWebsiteUrl = normalizeUrl(websiteUrl);
  return {
    displayName,
    websiteUrl: normalizedWebsiteUrl,
    websiteHost: new URL(normalizedWebsiteUrl).hostname.replace(/^www\./, ""),
    logoUrl: getFaviconUrl(normalizedWebsiteUrl),
    fallbackLogoUrl: getFaviconFallbackUrl(normalizedWebsiteUrl),
    githubUrl
  };
}

function getOwnerGithubUrl(owner, repos, metadata) {
  const bestRepo = [...repos].sort(compareRepos)[0];
  if (bestRepo?.repoKey) {
    return `https://github.com/${bestRepo.repoKey}`;
  }
  if (metadata.githubUrl) {
    return metadata.githubUrl;
  }
  return `https://github.com/${owner.sourceOwnerKeys?.[0] || owner.ownerKey}`;
}

function getFaviconUrl(websiteUrl) {
  const url = new URL(websiteUrl);
  return `${url.origin}/favicon.ico`;
}

function getFaviconFallbackUrl(websiteUrl) {
  const host = new URL(websiteUrl).hostname;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
}

function getOwnerInitial(value) {
  return String(value || "S").trim().charAt(0).toUpperCase();
}

function buildSearchText(values) {
  return values.filter(Boolean).join(" ").toLowerCase();
}

function hasKnownInstalls(owner, skills) {
  if (Number(owner.installsCount || 0) > 0) {
    return true;
  }
  return skills.some((skill) => (skill.sources || []).includes("skills.sh"));
}

function normalizeUrl(value) {
  const url = String(value || "").trim();
  return url.startsWith("http") ? url : `https://${url}`;
}

function prettifyOwnerName(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatNumber(value) {
  return new Intl.NumberFormat("en").format(Number(value || 0));
}

function formatCompactNumber(value) {
  return new Intl.NumberFormat("en", {
    maximumFractionDigits: Number(value) >= 1_000_000 ? 1 : 0,
    notation: Number(value) >= 10_000 ? "compact" : "standard"
  }).format(Number(value || 0));
}

function formatInstallCount(owner) {
  return owner.installsKnown ? formatCompactNumber(owner.installsCount || 0) : "N/A";
}

function addUtm(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("utm_source", "skillscout.sh");
    u.searchParams.set("utm_medium", "referral");
    return u.toString();
  } catch {
    return url;
  }
}
