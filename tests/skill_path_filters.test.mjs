import assert from "node:assert/strict";
import test from "node:test";

import { isAgentRuntimeSkillPath, shouldCatalogSkillFilePath } from "../scripts/skill_path_filters.mjs";

test("catalogues GoDaddy's documented gddy skill", () => {
  const skillPath = "godaddy/cli/.agents/skills/gddy";
  assert.equal(shouldCatalogSkillFilePath(`${skillPath}/SKILL.md`), true);
  assert.equal(isAgentRuntimeSkillPath(skillPath), false);
});

test("keeps the gddy exception scoped to its official repository and skill", () => {
  for (const skillPath of [
    "other/cli/.agents/skills/gddy",
    "godaddy/other/.agents/skills/gddy",
    "godaddy/cli/.agents/skills/internal",
    "godaddy/cli/.agents/skills/gddy-internal"
  ]) {
    assert.equal(shouldCatalogSkillFilePath(`${skillPath}/SKILL.md`), false, skillPath);
    assert.equal(isAgentRuntimeSkillPath(skillPath), true, skillPath);
  }
});
