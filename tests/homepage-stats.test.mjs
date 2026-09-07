import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { renderHomepageStats } from "../scripts/homepage-stats.mjs";

const homepage = await fs.readFile(new URL("../docs/index.html", import.meta.url), "utf8");

test("homepage counters update from catalog statistics on every build", () => {
  const first = renderHomepageStats(homepage, { owners: 1234, repos: 2345, skills: 34567 });
  assert.match(first, /id="landingOfficialOwners">1,234<\/p>/);
  assert.match(first, /id="landingOfficialRepos">2,345<\/p>/);
  assert.match(first, /id="landingOfficialSkills">34,567<\/p>/);
  const updated = renderHomepageStats(first, { owners: 0, repos: 3000, skills: 40000 });
  assert.match(updated, /id="landingOfficialOwners">0<\/p>/);
  assert.match(updated, /id="landingOfficialRepos">3,000<\/p>/);
  assert.match(updated, /id="landingOfficialSkills">40,000<\/p>/);
  assert.doesNotMatch(updated, /official-skills-universal\.json/);
});

test("invalid data and missing counters fail the build", () => {
  assert.throws(() => renderHomepageStats(homepage, { owners: 1, repos: 2 }), /Invalid homepage catalog statistic: skills/);
  assert.throws(() => renderHomepageStats("", { owners: 1, repos: 2, skills: 3 }), /Expected one homepage counter/);
});
