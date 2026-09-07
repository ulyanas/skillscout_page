const COUNTERS = {
  owners: "landingOfficialOwners",
  repos: "landingOfficialRepos",
  skills: "landingOfficialSkills"
};

export function renderHomepageStats(html, stats) {
  for (const [key, id] of Object.entries(COUNTERS)) {
    const value = stats?.[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid homepage catalog statistic: ${key}`);
    }
    const counter = new RegExp(`(<p\\b[^>]*\\bid="${id}"[^>]*>)[^<]*(</p>)`, "g");
    if ([...html.matchAll(counter)].length !== 1) {
      throw new Error(`Expected one homepage counter: ${id}`);
    }
    html = html.replace(counter, (_, open, close) => `${open}${value.toLocaleString("en-US")}${close}`);
  }
  return html;
}
