const AGENT_RUNTIME_SKILL_DIR_RE = /(?:^|\/)\.(?:claude|agents|codex|cursor|windsurf)\/skills(?:\/|$)/i;
const TEMPLATE_SKILL_FILE_RE = /(^|\/)templates?\/skill\/SKILL\.md$/i;

export function isAgentRuntimeSkillFilePath(filePath) {
  return AGENT_RUNTIME_SKILL_DIR_RE.test(String(filePath || ""));
}

export function isAgentRuntimeSkillPath(skillPath) {
  return AGENT_RUNTIME_SKILL_DIR_RE.test(String(skillPath || ""));
}

export function isTemplateSkillFilePath(filePath) {
  return TEMPLATE_SKILL_FILE_RE.test(String(filePath || ""));
}

export function shouldCatalogSkillFilePath(filePath) {
  return !isTemplateSkillFilePath(filePath) && !isAgentRuntimeSkillFilePath(filePath);
}
