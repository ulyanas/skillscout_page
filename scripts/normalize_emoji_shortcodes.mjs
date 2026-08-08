import fs from "node:fs/promises";

import { normalizeEmojiShortcodesInDirectory } from "./emoji_shortcodes.mjs";

const dataPath = process.env.OFFICIAL_SKILLS_OUTPUT || "docs/data/official-skills-universal.json";
const directory = JSON.parse(await fs.readFile(dataPath, "utf8"));

normalizeEmojiShortcodesInDirectory(directory);

await fs.writeFile(dataPath, `${JSON.stringify(directory, null, 2)}\n`);
console.log(`Normalized emoji shortcodes in ${dataPath}`);
