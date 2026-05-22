import {
  COMMON_TITLE_WORDS,
  GENERIC_KEYWORD_PHRASES,
  MAX_KEYWORD_WORDS
} from "./constants.js";

export function collapseKeyword(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s+[|:-]\s+/g, " ");
}

export function normalizeTextForMatching(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeKeywordCandidate(value) {
  const collapsed = collapseKeyword(value);
  const normalized = normalizeTextForMatching(collapsed);
  const words = normalized.split(" ").filter(Boolean);

  if (!collapsed || !words.length || words.length > MAX_KEYWORD_WORDS) {
    return "";
  }

  if (COMMON_TITLE_WORDS.has(normalized) || GENERIC_KEYWORD_PHRASES.has(normalized)) {
    return "";
  }

  return words.join(" ");
}

export function parseCompactNumber(value) {
  const normalized = String(value || "")
    .trim()
    .replaceAll(",", "")
    .replaceAll("+", "");
  const match = normalized.match(/^([0-9]+(?:\.[0-9]+)?)([kKmM]?)$/);
  if (!match) {
    return Number(normalized) || 0;
  }

  const base = Number(match[1]);
  const suffix = match[2].toUpperCase();
  const multiplier = suffix === "K" ? 1000 : suffix === "M" ? 1000000 : 1;
  return Math.round(base * multiplier);
}

export function fallbackDescription(skill) {
  const name = String(skill.name || skill.skillId || "this skill").replaceAll("-", " ");
  return `A skill for ${name}.`;
}

export function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

export function createMetric(kind, value, source, confidence = 1) {
  if (!Number.isFinite(Number(value))) {
    return null;
  }

  return {
    kind,
    value: Number(value),
    source,
    confidence
  };
}

export function buildCanonicalSkill(rawSkill, sourceDirectory) {
  const source = String(rawSkill.source || "");
  const [repoOwner = "", repoName = ""] = source.split("/", 2);
  const skillId = String(rawSkill.skillId || rawSkill.slug || "");
  const metrics = [];
  const weeklyInstallsMetric = createMetric(
    "weekly_installs",
    rawSkill.installs,
    sourceDirectory,
    0.8
  );
  if (weeklyInstallsMetric) {
    metrics.push(weeklyInstallsMetric);
  }

  return {
    canonicalId: `${sourceDirectory}::${source}::${skillId}`,
    sourceDirectory,
    sourceSkillUrl:
      rawSkill.url ||
      (rawSkill.id?.startsWith("http")
        ? rawSkill.id
        : source && skillId
          ? `https://www.skills.sh/${source}/${skillId}`
          : ""),
    name: rawSkill.name || skillId || "Unnamed skill",
    skillId,
    slug: skillId || undefined,
    description: rawSkill.description || "",
    source,
    repoOwner: repoOwner || undefined,
    repoName: repoName || undefined,
    repoUrl: repoOwner && repoName ? `https://github.com/${repoOwner}/${repoName}` : "",
    metrics,
    raw: rawSkill
  };
}

export function dedupeCanonicalSkills(skills) {
  const byKey = new Map();

  for (const skill of skills) {
    const key = getCanonicalDedupeKey(skill);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...skill,
        matchedIn: [skill.sourceDirectory]
      });
      continue;
    }

    byKey.set(key, {
      ...existing,
      source: existing.source || skill.source,
      repoOwner: existing.repoOwner || skill.repoOwner,
      repoName: existing.repoName || skill.repoName,
      repoUrl: existing.repoUrl || skill.repoUrl,
      ownerHandle: existing.ownerHandle || skill.ownerHandle,
      installCommand: existing.installCommand || skill.installCommand,
      name: pickPreferredName(existing.name, skill.name),
      skillId: existing.skillId || skill.skillId,
      slug: existing.slug || skill.slug,
      metrics: mergeMetrics(existing.metrics || [], skill.metrics || []),
      description: pickPreferredDescription(existing.description, skill.description),
      sourceSkillUrl: existing.sourceSkillUrl || skill.sourceSkillUrl,
      verification: {
        ...(existing.verification || {}),
        ...(skill.verification || {})
      },
      officialCatalogMatch: Boolean(existing.officialCatalogMatch || skill.officialCatalogMatch),
      matchedIn: [...new Set([...(existing.matchedIn || [existing.sourceDirectory]), skill.sourceDirectory])],
      raw: existing.raw || skill.raw
    });
  }

  return [...byKey.values()];
}

function getCanonicalDedupeKey(skill) {
  if (skill.repoOwner && skill.repoName && skill.skillId) {
    return `${skill.repoOwner}/${skill.repoName}::${skill.skillId}`.toLowerCase();
  }

  const normalizedSkillId = normalizeTextForMatching(skill.skillId || skill.slug || "");
  const normalizedName = normalizeTextForMatching(skill.name || "");
  if (normalizedSkillId && normalizedName && normalizedSkillId === normalizedName) {
    return `slug:${normalizedSkillId}`;
  }

  return String(skill.canonicalId || `${skill.sourceDirectory}::${skill.skillId || skill.name || "unknown"}`);
}

function pickPreferredDescription(left, right) {
  const first = String(left || "").trim();
  const second = String(right || "").trim();
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  return second.length > first.length ? second : first;
}

function pickPreferredName(left, right) {
  const first = String(left || "").trim();
  const second = String(right || "").trim();
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  return second.length > first.length ? second : first;
}

function mergeMetrics(left, right) {
  const merged = new Map();
  for (const metric of [...left, ...right]) {
    if (!metric) {
      continue;
    }

    const key = `${metric.kind}::${metric.source}`;
    const existing = merged.get(key);
    if (!existing || metric.value > existing.value) {
      merged.set(key, metric);
    }
  }
  return [...merged.values()];
}
