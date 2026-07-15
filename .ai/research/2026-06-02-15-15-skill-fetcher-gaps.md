# Skill Fetcher Gaps

## Summary

Seven newly observed GitHub repositories with agent skills were checked against the current SkillScout discovery pipeline. None matched the current GitHub discovery queries, because the repositories do not contain the exact phrase `skills install` and do not use the `agent-skills` GitHub topic.

SkillScout discovery currently samples two GitHub searches in `scripts/auto_add_vendors.mjs`: `filename:SKILL.md "skills install"` and `topic:agent-skills pushed:>${since}`. Both searches request only the first 100 results. Daily discovery runs this script with a 14-day window in `.github/workflows/discover-vendors.yml`.

The `skills.sh` scraper reads official catalog pages only, so publisher pages such as `skills.sh/surgepix/agent-skills` and `skills.sh/wasp-lang/open-saas` do not create new official entries.

## Checked Repositories

| Repository | In SkillScout | GitHub topic `agent-skills` | Exact phrase `skills install` | Skills found | Main miss reason |
| --- | --- | --- | --- | ---: | --- |
| `Orvanta-Cloud/orvanta-cli-docs` | No | No | No | 28 | GitHub query gate |
| `EvolveHQ/docflow` | No | No | No | 8 | GitHub query gate; empty org website |
| `cmu-impactlab/GA-Skill-Evolution` | No | No | No | 2 | GitHub query gate; empty org website |
| `SurgePix/agent-skills` | No | No | No | 4 | GitHub query gate; publisher page outside official scrape |
| `windmill-labs/windmill-cli-docs` | No | No | No | 27 | GitHub query gate; skills.sh page maps to `windmill-labs/windmill` |
| `vtex/skills` | Yes | No | No | 135 total, 90 indexed | Enrichment accepts uppercase `SKILL.md` only |
| `wasp-lang/open-saas` | No | No | No | 3 | GitHub query gate; publisher page outside official scrape |

## Code References

- `scripts/auto_add_vendors.mjs:78` starts the two discovery searches.
- `scripts/auto_add_vendors.mjs:104` dedupes candidates by owner and skips owners that already exist.
- `scripts/auto_add_vendors.mjs:132` fetches `/orgs/{login}` for owner verification.
- `scripts/auto_add_vendors.mjs:249` requires a GitHub Organization.
- `scripts/auto_add_vendors.mjs:257` requires a live organization website and Companies API match.
- `scripts/scrape_official_skills.mjs:27` limits scraping to `skills.sh/official` and `mcpservers.org/agent-skills/official`.
- `scripts/enrich_github_skills.mjs:54` enriches only repos already present in `officialRepos`.
- `scripts/enrich_github_skills.mjs:95` fetches GitHub trees for existing repos.
- `scripts/enrich_github_skills.mjs:108` accepts `SKILL.md` with uppercase casing only.

## Repo Notes

`Orvanta-Cloud/orvanta-cli-docs` has 28 uppercase `SKILL.md` files under `skills/`. GitHub org metadata includes `https://orvanta.ai/`. It is absent from skills.sh owner and repo pages checked during this analysis.

`EvolveHQ/docflow` has 8 uppercase `SKILL.md` files under `skills/`. The GitHub organization has an empty `blog` field, so it would fail the current website verification even after discovery.

`cmu-impactlab/GA-Skill-Evolution` has 2 uppercase `SKILL.md` files under `skills/`. The GitHub organization has an empty `blog` field, so it would fail the current website verification even after discovery.

`SurgePix/agent-skills` has 4 uppercase `SKILL.md` files. Its skills.sh repo page is live, but `skills.sh/official` does not list SurgePix in the fetched page content.

`windmill-labs/windmill-cli-docs` has 27 uppercase `SKILL.md` files. `skills.sh/windmill-labs` is live and points to `windmill-labs/windmill`, while `skills.sh/windmill-labs/windmill-cli-docs` returns 404.

`vtex/skills` is already present in SkillScout. GitHub contains 90 uppercase `SKILL.md` files and 45 lowercase `skill.md` files. `auto_add_vendors.mjs` counts either casing during candidate verification, while `enrich_github_skills.mjs` indexes uppercase `SKILL.md` only.

`wasp-lang/open-saas` has 3 uppercase `SKILL.md` files under `template/app/.agents/skills/`. Its skills.sh repo page is live, but `skills.sh/official` does not list Wasp in the fetched page content.

## Follow-Up Ideas

Broaden GitHub discovery to query for `filename:SKILL.md` and `filename:skill.md` with path patterns or repository tree validation instead of the exact `skills install` phrase.

Paginate or shard GitHub search results beyond the first 100 items.

Add a skills.sh publisher/repository discovery path if non-official skills.sh pages are intended inputs.

Align enrichment casing with discovery counting so lowercase `skill.md` files are indexed.
