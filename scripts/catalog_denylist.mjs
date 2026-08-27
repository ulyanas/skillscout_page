/**
 * Owners, repos, and skills that must never appear in the official directory.
 *
 * Entries here are removed by scripts/purge_denylisted_skills.mjs and are
 * refused at ingestion time by the scrape and discovery scripts, so a scheduled
 * re-scrape cannot bring them back.
 *
 * Run scripts/purge_denylisted_skills.mjs after adding an entry.
 */

// arm — all entries removed 2026-08-27 at the vendor's request; source
// repositories are no longer public. Denylisted at the owner level so the
// affected repository names are not enumerated in this public repo.
const DENIED_OWNER_KEYS = new Set(["arm"]);

const DENIED_REPO_KEYS = new Set([]);

function normalizeKey(key) {
  return String(key || "").trim().toLowerCase();
}

export function isDeniedOwnerKey(ownerKey) {
  return DENIED_OWNER_KEYS.has(normalizeKey(ownerKey));
}

export function isDeniedRepoKey(repoKey) {
  const key = normalizeKey(repoKey);
  if (!key) return false;
  if (DENIED_REPO_KEYS.has(key)) return true;
  return isDeniedOwnerKey(key.split("/")[0]);
}

export function isDeniedSkillKey(skillKey) {
  const key = normalizeKey(skillKey);
  if (!key) return false;
  const [owner, repo] = key.split("/");
  return isDeniedOwnerKey(owner) || isDeniedRepoKey(`${owner}/${repo}`);
}

export function isDeniedRecord(record) {
  if (!record) return false;
  return (
    isDeniedOwnerKey(record.ownerKey) ||
    isDeniedRepoKey(record.repoKey) ||
    isDeniedSkillKey(record.skillKey)
  );
}
