const AGENT_RUNTIME_SKILL_DIR_RE = /(?:^|\/)\.(?:claude|agents|codex|cursor|windsurf)\/skills(?:\/|$)/i;
const TEMPLATE_SKILL_FILE_RE = /(^|\/)templates?\/skill\/SKILL\.md$/i;
const AGENT_RUNTIME_SKILL_PATH_EXCEPTIONS = [
  /^home-assistant\/(?:android|core|frontend|home-assistant\.io|ios)\/\.(?:agents|claude)\/skills\//i,
  // OpenSEO ships its documented product skills under .agents/skills; the repo's
  // internal maintenance skills stay excluded.
  /^every-app\/open-seo\/\.agents\/skills\/(?:competitive-landscape|competitor-analysis|keyword-clustering|keyword-research|link-prospecting|local-seo|seo-audit|seo-coach|seo-project-setup)(?:\/|$)/i
];

export function isAgentRuntimeSkillFilePath(filePath) {
  const normalizedPath = String(filePath || "");
  return AGENT_RUNTIME_SKILL_DIR_RE.test(normalizedPath) && !isAgentRuntimeSkillPathException(normalizedPath);
}

export function isAgentRuntimeSkillPath(skillPath) {
  const normalizedPath = String(skillPath || "");
  return AGENT_RUNTIME_SKILL_DIR_RE.test(normalizedPath) && !isAgentRuntimeSkillPathException(normalizedPath);
}

export function isTemplateSkillFilePath(filePath) {
  return TEMPLATE_SKILL_FILE_RE.test(String(filePath || ""));
}

export function shouldCatalogSkillFilePath(filePath) {
  return !isTemplateSkillFilePath(filePath) && !isAgentRuntimeSkillFilePath(filePath);
}

export function isAgentRuntimeSkillPathException(skillPath) {
  const normalizedPath = String(skillPath || "");
  return AGENT_RUNTIME_SKILL_PATH_EXCEPTIONS.some((pattern) => pattern.test(normalizedPath));
}
