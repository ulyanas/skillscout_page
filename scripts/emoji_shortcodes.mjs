const EMOJI_SHORTCODES = new Map([
  ["blue_book", "📘"],
  ["earth_americas", "🌎"],
  ["heart", "❤️"],
  ["house_with_garden", "🏡"],
  ["iphone", "📱"],
  ["lollipop", "🍭"],
  ["sparkles", "✨"]
]);

const EMOJI_SHORTCODE_RE = /:([a-z0-9_+-]+):/gi;

export function decodeEmojiShortcodes(value) {
  if (typeof value !== "string" || !value.includes(":")) return value;
  return value.replace(EMOJI_SHORTCODE_RE, (match, shortcode) => {
    return EMOJI_SHORTCODES.get(String(shortcode).toLowerCase()) || match;
  });
}

export function normalizeEmojiShortcodesInDirectory(directory) {
  for (const collectionName of ["officialOwners", "officialRepos", "officialSkills"]) {
    for (const item of directory?.[collectionName] || []) {
      normalizeEmojiShortcodesInItem(item);
    }
  }
}

function normalizeEmojiShortcodesInItem(item) {
  for (const key of ["displayName", "description", "repoName", "website", "websiteUrl"]) {
    if (typeof item[key] === "string") {
      item[key] = decodeEmojiShortcodes(item[key]);
    }
  }
}
