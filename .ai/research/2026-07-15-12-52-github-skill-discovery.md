---
date: 2026-07-15T12:52:43+03:00
researcher: AI Agent
target_project: skillscout_page
target_project_root: /Users/ulyanas/skillscout_page
workspace_root: /Users/ulyanas/skillscout_page
research_dir: /Users/ulyanas/skillscout_page/.ai/research
target_git_available: true
target_git_root: /Users/ulyanas/skillscout_page
target_git_commit: f960091374360ab5211bcefcb1d5e7534b0dff3e
target_git_branch: main
target_git_remote: https://github.com/ulyanas/skillscout_page.git
title: "GitHub skill discovery"
tags: [skills, github, discovery, automation]
status: complete
last_updated: 2026-07-15
last_updated_by: AI Agent
---
# Research: GitHub skill discovery

## Research Question
Проверить, работают ли скрипты поиска skills по GitHub, и объяснить, почему в последнее время почти нет добавления новых vendors.

## Summary
GitHub API доступен с локального токена: `gh api rate_limit` показал `search.remaining=30` и `code_search.remaining=10` на 2026-07-15. Локальные прямые запросы к GitHub search возвращали данные: `filename:SKILL.md "skills install"` дал `3792` результата, `filename:SKILL.md` дал `248952`, `topic:agent-skills pushed:>2026-07-01` дал `3783`.

Scheduled workflow `Discover & add new skill vendors` успешно запускался 2026-07-14 и 2026-07-15, но добавлял `0` owners и `0` repos. В логах 2026-07-15 code-search получил `429`, topic-search сработал и дал `96` candidates, затем verification funnel отфильтровал всех без подробной причины в опубликованной версии.

Локальная рабочая копия уже содержала расширенный discovery script, но dry-run падал на первом успешном repo add из-за `ReferenceError: ownerKey is not defined`. Исправление заменило поле repo record на `ownerKey: info.ownerKey`.

## Detailed Findings
### Scheduled Discovery
- `.github/workflows/discover-vendors.yml:4-6` запускает discovery ежедневно в `04:00 UTC` и вручную через `workflow_dispatch`.
- `.github/workflows/discover-vendors.yml:21-28` запускает `node scripts/auto_add_vendors.mjs` с `GITHUB_TOKEN`, `COMPANIES_API_KEY`, `OFFICIAL_SKILLS_OUTPUT=docs/data/official-skills-universal.json`, `DISCOVERY_WINDOW_DAYS=14`.
- `.github/workflows/discover-vendors.yml:29-33` запускает `node scripts/enrich_github_skills.mjs` после discovery.
- Лог run `29393215993` от 2026-07-15: code-search `SKILL.md containing "skills install"` вернул `Search failed (429)`, topic-search вернул `3736 total, got 100`, найдено `96 unknown orgs`, добавлено `0` owners и `0` repos.
- Лог run `29310174079` от 2026-07-14: тот же code-search `429`, topic-search `3574 total, got 100`, найдено `89 unknown orgs`, добавлено `0` owners и `0` repos.

### Auto Add Script
- `scripts/auto_add_vendors.mjs:37-44` читает `GITHUB_TOKEN`, `COMPANIES_API_KEY`, `DISCOVERY_WINDOW_DAYS`, `DISCOVERY_SEARCH_PAGES`, seed flags and `DRY_RUN`.
- `scripts/auto_add_vendors.mjs:81-124` после исправления выполняет несколько GitHub queries последовательно, использует `fetchWithRetry`, поддерживает pagination and rate-limit waits.
- `scripts/auto_add_vendors.mjs:104-113` ищет `filename:SKILL.md "skills install"`, `filename:SKILL.md "skills add"`, `filename:SKILL.md`, `filename:skill.md`, `topic:agent-skills pushed:>${since}`, `topic:claude-skills pushed:>${since}`.
- `scripts/auto_add_vendors.mjs:389-431` проверяет candidate через GitHub org endpoint, exact skill paths, website liveness and Companies API.
- `scripts/auto_add_vendors.mjs:413-492` после текущих правок добавляет new repos even when owner already exists, merges owner metadata for existing owners, and stores `githubSkillPaths`.
- `scripts/auto_add_vendors.mjs:519-533` supports `DRY_RUN=1` and prints a rejection summary.

### Deep Scan
- `.github/workflows/deep-scan-vendors.yml:3-7` manual-only. Последний найденный run `26411280184` был 2026-05-25.
- `scripts/deep_scan_vendors.mjs:59-71` has GitHub retry handling; текущая правка добавила fetch exception retry.
- `scripts/deep_scan_vendors.mjs:155-183` после текущей правки запускает searches последовательно and includes lowercase `filename:skill.md`.
- Лог deep scan от 2026-05-25: code-search requests hit rate limits and returned `0` results, topic searches returned `1000` each, scan verified `1650` candidates and added `17` vendors.

### Enrichment
- `scripts/enrich_github_skills.mjs:54-83` scans already-known `officialRepos`; new repo discovery happens in `auto_add_vendors`.
- `scripts/enrich_github_skills.mjs:85-127` fetches recursive Git trees and accepts `SKILL.md` and `skill.md` paths in the current worktree.
- Latest scrape run `29399060125` on 2026-07-15 fetched `595` GitHub trees from `655` repos, reconciled `10369` GitHub skills, updated `5587` skills.sh install mappings, and wrote a directory with `231 owners`, `655 repos`, `10822 skills`.

### Verification Runs
- `DRY_RUN=1 DISCOVERY_SKIP_SEARCH=1 DISCOVERY_SEED_REPOS=JetBrains/skills` on a temp copy of `origin/main` JSON completed successfully: found 1 candidate, verified `jetbrains/skills`, added `1` repo to an existing owner, wrote no files.
- `DRY_RUN=1 DISCOVERY_SEARCH_PAGES=1` on a temp copy completed successfully: six GitHub queries returned 600 raw items, 457 candidate repos, 7 new repos to existing owners, and wrote no files.
- That dry-run rejection summary was: `org profile not found: 365`, `website unavailable: 47`, `Companies API miss: 33`, `no SKILL.md or skill.md found: 5`.
- `node --check` passed for `scripts/auto_add_vendors.mjs`, `scripts/deep_scan_vendors.mjs`, `scripts/enrich_github_skills.mjs`, `scripts/scrape_official_skills.mjs`, and `scripts/enrich_owner_metadata.mjs`.

## Code References
- `.github/workflows/discover-vendors.yml:21` - daily discovery script entry point.
- `.github/workflows/deep-scan-vendors.yml:3` - deep scan is manual-only.
- `.github/workflows/scrape-official.yml:21` - official scrape entry point.
- `scripts/auto_add_vendors.mjs:81` - GitHub search pagination and retry.
- `scripts/auto_add_vendors.mjs:104` - current discovery query list.
- `scripts/auto_add_vendors.mjs:389` - candidate verification loop.
- `scripts/auto_add_vendors.mjs:500` - repo record construction with `ownerKey: info.ownerKey`.
- `scripts/deep_scan_vendors.mjs:59` - GitHub fetch retry helper.
- `scripts/deep_scan_vendors.mjs:155` - historical scan query sequence.
- `scripts/enrich_github_skills.mjs:54` - GitHub tree enrichment over known repos.
- `scripts/enrich_owner_metadata.mjs:52` - owner metadata enrichment over known owners.

## Open Questions
- The GitHub Actions `GITHUB_TOKEN` produced `429` for code search on 2026-07-14 and 2026-07-15. The updated sequential retry path needs a workflow run after commit to confirm behavior in Actions.
- The local branch is behind `origin/main` (`f960091` local, `3dad28d` remote at research time), and the working tree contains pre-existing uncommitted changes in `scripts/enrich_github_skills.mjs` plus untracked `.claude/` and `docs/skillscout-ui-mock.html`.
