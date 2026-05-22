import { normalizeTextForMatching } from "./canonical.js";

export function rankCanonicalSkills(skills, siteContext = { preferredOwners: [] }) {
  const relevanceTerms = buildRelevanceTerms(siteContext);

  return [...skills]
    .map((skill) => {
      const relevanceScore = scoreKeywordRelevance(skill, relevanceTerms);
      const officialCatalogMatch = Boolean(skill.officialCatalogMatch || skill.verification?.officialCatalog);
      const officialVendorMatch = isOfficialVendorSkill(skill, siteContext.preferredOwners);
      const officialCatalogRelevant = officialCatalogMatch && relevanceScore > 0;
      const officialVendorRelevant = officialVendorMatch && relevanceScore > 0;
      const relevanceTier = relevanceScore >= 4 ? 3 : relevanceScore >= 3 ? 2 : relevanceScore >= 2 ? 1 : 0;
      const officialPriority =
        officialCatalogRelevant && relevanceTier >= 2
          ? 3
          : officialVendorRelevant && relevanceTier >= 2
            ? 2
            : officialCatalogRelevant
              ? 1
              : 0;
      const popularityScore = computePopularityScore(skill.metrics || []);
      const trustScore = computeTrustScore(skill.metrics || []);
      const finalScore =
        relevanceScore * 1000 +
        Number(Boolean(officialCatalogRelevant)) * 300 +
        Number(Boolean(officialVendorRelevant)) * 200 +
        popularityScore * 50 +
        trustScore * 25;

      return {
        ...skill,
        relevanceScore,
        relevanceTier,
        officialCatalogMatch,
        officialCatalogRelevant,
        officialVendorMatch,
        officialVendorRelevant,
        officialPriority,
        popularityScore,
        trustScore,
        finalScore,
        rankScore: Math.round(finalScore)
      };
    })
    .sort((left, right) => {
      return (
        (right.officialPriority || 0) - (left.officialPriority || 0) ||
        (right.relevanceTier || 0) - (left.relevanceTier || 0) ||
        (right.relevanceScore || 0) - (left.relevanceScore || 0) ||
        Number(Boolean(right.officialCatalogRelevant)) - Number(Boolean(left.officialCatalogRelevant)) ||
        Number(Boolean(right.officialVendorRelevant)) - Number(Boolean(left.officialVendorRelevant)) ||
        (right.popularityScore || 0) - (left.popularityScore || 0) ||
        String(left.name || "").localeCompare(String(right.name || ""))
      );
    });
}

export function buildRelevanceTerms(siteContext = {}) {
  return [
    ...new Set(
      [siteContext.keyword, ...(siteContext.searchTerms || [])]
        .map(normalizeTextForMatching)
        .filter(Boolean)
    )
  ];
}

export function scoreKeywordRelevance(skill, relevanceTerms = []) {
  if (!relevanceTerms.length) {
    return 0;
  }

  const name = normalizeTextForMatching(String(skill.name || ""));
  const skillId = normalizeTextForMatching(String(skill.skillId || ""));
  const description = normalizeTextForMatching(String(skill.description || ""));
  let bestScore = 0;

  for (const term of relevanceTerms) {
    const tokens = term.split(" ").filter(Boolean);

    if (name === term || skillId === term) {
      bestScore = Math.max(bestScore, 5);
      continue;
    }

    if (name.startsWith(term) || skillId.startsWith(term)) {
      bestScore = Math.max(bestScore, 4);
      continue;
    }

    if (name.includes(term) || skillId.includes(term)) {
      bestScore = Math.max(bestScore, 3);
      continue;
    }

    if (description.includes(term)) {
      bestScore = Math.max(bestScore, 2);
      continue;
    }

    if (
      tokens.length > 1 &&
      tokens.every((token) => name.includes(token) || skillId.includes(token) || description.includes(token))
    ) {
      bestScore = Math.max(bestScore, 2);
    }
  }

  return bestScore;
}

export function computePopularityScore(metrics = []) {
  if (!metrics.length) {
    return 0;
  }

  const normalizedValues = metrics
    .map((metric) => normalizeMetric(metric))
    .filter((value) => Number.isFinite(value));

  if (!normalizedValues.length) {
    return 0;
  }

  return normalizedValues.reduce((sum, value) => sum + value, 0);
}

function normalizeMetric(metric) {
  const value = Number(metric.value);
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  const logValue = Math.log10(value + 1);

  switch (metric.kind) {
    case "weekly_installs":
      return logValue * 1.0;
    case "monthly_installs":
      return Math.log10(value / 4.345 + 1) * 0.95;
    case "all_time_installs":
      return logValue * 0.5;
    case "github_stars":
      return logValue * 0.45;
    case "trending_rank":
      return (100 - Math.min(100, value)) * 0.03;
    default:
      return 0;
  }
}

function computeTrustScore(metrics = []) {
  return metrics.reduce((sum, metric) => {
    if (metric.kind === "quality_score" || metric.kind === "security_score") {
      return sum + Number(metric.value || 0);
    }
    return sum;
  }, 0);
}

function isOfficialVendorSkill(skill, preferredOwners = []) {
  const owner = String(skill.repoOwner || "").toLowerCase();
  if (!owner) {
    return false;
  }

  return preferredOwners.some((candidate) => owner === String(candidate || "").toLowerCase());
}
