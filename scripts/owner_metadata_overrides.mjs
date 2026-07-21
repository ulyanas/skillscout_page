export const OWNER_METADATA_OVERRIDES = new Map([
  ["anthropics", { displayName: "Anthropic", website: "https://www.anthropic.com" }],
  ["axiomhq", { displayName: "Axiom", website: "https://axiom.co" }],
  ["base", { displayName: "Base", website: "https://www.base.org" }],
  ["browser-use", { displayName: "Browser Use", website: "https://browser-use.com" }],
  ["callstackincubator", { displayName: "Callstack", website: "https://www.callstack.com" }],
  ["canva", { displayName: "Canva", website: "https://www.canva.com", githubUrl: "https://github.com/canva" }],
  ["clerk", { displayName: "Clerk", website: "https://clerk.com" }],
  ["coderabbitai", { displayName: "CodeRabbit", website: "https://www.coderabbit.ai" }],
  ["coinbase", { displayName: "Coinbase", website: "https://www.coinbase.com" }],
  ["convex-dev", { displayName: "Convex", website: "https://www.convex.dev" }],
  ["elevenlabs", { displayName: "ElevenLabs", website: "https://elevenlabs.io" }],
  ["expo", { displayName: "Expo", website: "https://expo.dev" }],
  ["google-labs-code", { displayName: "Google Labs", website: "https://labs.google" }],
  ["hashicorp", { displayName: "HashiCorp", website: "https://www.hashicorp.com" }],
  ["mcp-use", { displayName: "mcp-use", website: "https://mcp-use.com" }],
  ["medusajs", { displayName: "Medusa", website: "https://medusajs.com" }],
  ["n8n-io", { displayName: "n8n", website: "https://n8n.io" }],
  ["nuxt", { displayName: "Nuxt", website: "https://nuxt.com" }],
  ["projectopensea", { displayName: "OpenSea", website: "https://opensea.io" }],
  ["remotion-dev", { displayName: "Remotion", website: "https://www.remotion.dev" }],
  ["rivet-dev", { displayName: "Rivet", website: "https://rivet.gg" }],
  ["streamlit", { displayName: "Streamlit", website: "https://streamlit.io" }],
  ["tinybirdco", { displayName: "Tinybird", website: "https://www.tinybird.co" }],
  ["vercel-labs", { displayName: "Vercel Labs", website: "https://vercel.com" }],
  ["wordpress", { displayName: "WordPress", website: "https://wordpress.org" }]
]);

export function applyOwnerMetadataOverrides(directory, stats = null) {
  for (const owner of directory.officialOwners || []) {
    const metadata = OWNER_METADATA_OVERRIDES.get(owner.ownerKey);
    if (!metadata) continue;

    owner.websiteHosts ||= [];
    owner.normalizedNames ||= [];
    owner.sourceUrls ||= [];

    if (metadata.displayName) {
      owner.displayName = metadata.displayName;
      addUnique(owner.normalizedNames, normalizeName(metadata.displayName));
    }

    if (metadata.website && !owner.website) {
      owner.website = metadata.website;
      if (stats && typeof stats.websitesAdded === "number") {
        stats.websitesAdded++;
      }
    }

    const websiteHost = hostFromUrl(owner.website);
    if (websiteHost) {
      addUnique(owner.websiteHosts, websiteHost);
    }

    if (metadata.githubUrl && !owner.githubUrl) {
      owner.githubUrl = metadata.githubUrl;
      addUnique(owner.sourceUrls, metadata.githubUrl);
    }
  }
}

function addUnique(list, value) {
  if (!value) return;
  if (!list.includes(value)) list.push(value);
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&amp;/g, "and")
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.startsWith("http") ? raw : `https://${raw}`;
}

function hostFromUrl(value) {
  try {
    return new URL(normalizeUrl(value)).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}
