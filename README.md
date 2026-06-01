# AI Product Radar

Local runner for the daily AI product radar automation.

The goal is to make the automation testable instead of relying only on a long natural-language prompt.

GitHub archive: https://github.com/BENZEMA216/ai-product-radar

GitHub Pages site: https://benzema216.github.io/ai-product-radar/

## Commands

```bash
npm run smoke
npm run build-site
npm run daily -- --hours 24
npm run publish-report
npm run radar -- --hours 24
npm run radar -- --now 2026-05-31T08:02:13+08:00 --hours 24
```

`npm run daily` is the automation entrypoint. It runs `npm run smoke` first, then writes the
daily Markdown table to `reports/YYYY-MM-DD-HHMM-cst.md`. If smoke fails, it still writes
the same table header plus a one-line blocker reason so the run is never invisible.

`npm run build-site` rebuilds `docs/index.html` from all Markdown reports under `reports/`.

`npm run publish-report` rebuilds the site, commits the newest report under `reports/`, and
pushes the current branch to `origin`, so daily outputs are reviewable in GitHub history and
on the GitHub Pages dashboard.

## Stability Contract

- Product Hunt is read through daily leaderboard pages, with Jina Reader fallback.
- Hacker News is read through Algolia API so each hit has `created_at`.
- GitHub releases are read through authenticated `gh api` when available.
- Hugging Face uses public API endpoints and only includes recent Spaces/Models with timestamps.
- X/Twitter is treated as best-effort discovery unless a visible official/creator timestamp can be verified.
- Daily automation output is persisted under `reports/`, even when the run is blocked.
- Daily reports are intended to be committed and pushed to the GitHub repository after generation.
- The GitHub Pages dashboard is generated from committed reports only; it does not depend on a backend.

## Current Status

- 2026-05-31: `npm run smoke` passed 3 consecutive local runs.
- Fixed-window dry run for `2026-05-31T08:02:13+08:00` returned 32 candidates from Product Hunt, Hacker News, GitHub, and Hugging Face after noise filtering.
- Current-window dry run returned candidates from the same structured source families.
- 2026-06-01: added `npm run daily` so scheduled runs always persist a report file before
  returning final output.
- Remaining known limitation: X/Twitter is not fully reliable without an authenticated/API-backed search path.
