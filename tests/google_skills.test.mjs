import assert from "node:assert/strict";
import test from "node:test";
import { importGoogleSkills } from "../scripts/import_google_skills.mjs";
import { OWNER_METADATA } from "../docs/lib/owner-metadata.js";

const now = "2026-09-09T12:00:00.000Z";
const index = { skills: [{
  name: "developing-genkit-js", description: "Build AI applications with Genkit. Use when developing agents.",
  entrypoint: "https://raw.githubusercontent.com/google/skills/main/skills/cloud/genkit-js/SKILL.md"
}] };
const empty = () => ({ officialOwners: [], officialRepos: [], officialSkills: [], stats: {} });

test("creates Google with canonical names, descriptions, and install commands", () => {
  const directory = empty();
  importGoogleSkills(directory, index, now);
  assert.equal(directory.officialOwners[0].displayName, "Google");
  assert.equal(directory.officialRepos[0].skillsCount, 1);
  const skill = directory.officialSkills[0];
  assert.equal(skill.skillName, "developing-genkit-js");
  assert.equal(skill.description, "Build AI applications with Genkit.");
  assert.equal(skill.installCommand, "npx skills add google/skills --skill developing-genkit-js");
  assert.equal(directory.stats.skills, 1);
  const snapshot = structuredClone(directory);
  importGoogleSkills(directory, index, now);
  assert.deepEqual(directory, snapshot);
});

test("merges plugin copies while preserving popularity and unrelated skills", () => {
  const directory = empty();
  const unrelated = { skillKey: "other/repo/skill", repoKey: "other/repo", ownerKey: "other", sources: ["github"] };
  directory.officialSkills.push(unrelated,
    { skillKey: "google/skills/skills/cloud/genkit-js", repoKey: "google/skills", skillName: "genkit-js", installsCount: 8 },
    { skillKey: "google/skills/plugins/example/genkit-js", repoKey: "google/skills", skillName: "genkit-js", installsCount: 12 });
  importGoogleSkills(directory, index, now);
  assert.equal(directory.officialSkills.length, 2);
  assert.deepEqual(directory.officialSkills.find((skill) => skill.ownerKey === "other"), unrelated);
  assert.equal(directory.officialSkills.find((skill) => skill.ownerKey === "google").installsCount, 12);
  assert.equal(directory.officialRepos[0].installsCount, 12);
});

test("validates the official index before modifying the catalogue", () => {
  for (const badIndex of [{ skills: [] }, { skills: [index.skills[0], index.skills[0]] },
    { skills: [{ ...index.skills[0], entrypoint: "https://example.com/SKILL.md" }] }]) {
    const directory = empty();
    assert.throws(() => importGoogleSkills(directory, badIndex, now));
    assert.deepEqual(directory, empty());
  }
});

test("Google and Google Workspace have distinct vendor identities", () => {
  assert.equal(OWNER_METADATA.google[0], "Google");
  assert.equal(OWNER_METADATA.google[2], "https://github.com/google");
  assert.equal(OWNER_METADATA.googleworkspace[0], "Google Workspace");
});
