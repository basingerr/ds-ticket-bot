# Developer ticket review

This is a small, manually triggered, read-only workflow for understanding the current QA ticket situation. It uses Codex as the analyst and does not use an OpenAI API integration, a dashboard, or a schedule.

## Safety boundary

- Read Trello cards, Trello actions/comments, and the local SQLite link database.
- Never change Trello or Discord during a review.
- Never download ticket attachments automatically. URLs may be inspected only when needed and explicitly requested.
- Keep snapshots and reports in ignored local/server directories. They can contain internal data.
- Distinguish facts from inference. Link every important conclusion to the supporting Trello card(s).

## Starting a review

Run:

```bash
npm run insights:export
```

The default is `--mode=pulse`. Use `--mode=deep` when all active records in scope should be included in the analysis bundle, and `--mode=baseline` (or `--full`) only when histories must be fetched again without reuse.

On the production VDS after a build:

```bash
npm run insights:export:prod
```

The exporter writes three immutable artifacts to `exports/ticket-review/`:

- `snapshot-*.json` — the complete authoritative snapshot;
- `snapshot-*.json.gz` — the same snapshot compressed for transfer;
- `review-bundle-*.json` — compact, sanitized analysis input selected by evidence depth.

It includes all active cards plus cards completed or archived within the last 30 days. Trello cards left unarchived in a final list such as `Готово` are still treated as done. Override the history window with `--closed-days=60`. Limit fetched actions per card with `--action-limit=100` when needed.

In pulse and deep modes, the exporter reads the newest compatible snapshot, compares a cheap Trello source revision, reuses unchanged action histories, and fetches actions only for new or changed cards. It still writes a complete new snapshot. A different board, schema, or action limit forces a fresh baseline automatically.

Never delete or overwrite earlier snapshots. They are the baseline for delta reviews. Compare snapshots only when their `schemaVersion` values match; after an exporter schema change, the first new snapshot becomes a fresh baseline.

Analyze `review-bundle-*.json` first. It removes Discord identity boilerplate and attachment URLs, identifies new, changed, moved, reopened, and newly stale records, and reports exact-hash semantic-cache hits. Open the full snapshot only when the compact evidence is ambiguous, high impact, or insufficient for diagnosis.

Compact per-card meaning lives in ignored `reports/the-manager/ticket-source-cache.json`. After reviewing a record, replace its cache entry with the current `contentHash`, concise meaning, classification, subsystem, cluster, evidence quality, recovery behavior, needs-info question, and review timestamp. Never copy raw ticket text into this cache.

The semantic review boundary lives separately in ignored `reports/the-manager/ticket-review-state.json`. The exporter may use the newest snapshot to reuse Trello histories, but the review bundle is always compared with `lastReviewedSnapshot`. Advance that field only after all required records in the bundle have been semantically reviewed and the cache and Manager ledger are updated. A repeated export before analysis must continue to show the pending changes.

## Publishing the team page

Only when the user explicitly asks to publish or update the shared page, write the approved human-facing summary as schema version 1 JSON to the configured `INSIGHTS_REPORT_PATH` (default `exports/ticket-review/published.json`). The `/insights` route reads this file for every request, so report updates do not require a bot restart.

Publishing the report file is allowed only after the user asks for it. It must not change Trello or Discord. Preserve immutable `snapshot-*.json` files; only the dedicated `published.json` presentation artifact may be replaced atomically.

The public-facing report must:

- exclude Discord user IDs, usernames, raw descriptions, comments, attachment URLs, and private operational details;
- contain concise conclusions, aggregate metrics, safe Trello links, and developer actions;
- distinguish confirmed clusters from broad themes and hypotheses;
- be reviewed for accidental secrets before publishing.

## Git activity enrichment

When the user asks to include developer activity, enrich the published report from the canonical game-code mirror:

```text
C:\Users\qwert\OneDrive\Documents\GTA5 Developer\external\rejoin-server
```

1. Fetch current remote refs without changing the working branch.
2. Use the two compared ticket snapshot timestamps as the review window.
3. Resolve the `origin/production` first-parent commit immediately before each boundary and compare the two production trees. Do not rely only on individual commit timestamps: an older dev commit may enter production through a merge inside the window.
4. Exclude merge duplication and inspect the actual diff before associating a change with a ticket or issue cluster.
5. Publish only safe commit/PR links and concise conclusions. Do not expose private code excerpts, credentials, internal IDs, or raw author data.

Use these evidence states:

- `confirmed` — a matching code change exists and Trello/QA also says Done;
- `awaiting_qa` — the change landed in the production branch, but deployment and/or QA confirmation is missing;
- `code_only` — relevant development activity exists, but its connection to a ticket is unproven.

A production-branch merge is not proof that the build is deployed to the game server, and a code change is not proof that the player-facing defect is fixed. Git evidence must never close a ticket automatically or reduce priority without QA or equivalent runtime confirmation.

Page availability and HTTP Basic authentication are controlled separately through `INSIGHTS_ENABLED`, `INSIGHTS_USERNAME`, and `INSIGHTS_PASSWORD`. Never put the password into a report or commit it.

## Supported review modes

### Full review

Trigger examples:

```text
Сделай полный обзор тикетов
Какие проблемы сейчас самые приоритетные?
Что происходит с QA тикетами?
```

Use the newest snapshot. Focus on open work, but use recent closed cards to recognize regressions and resolved themes.

### Delta review

Trigger examples:

```text
Что изменилось с прошлого анализа?
Есть что-то новое по тикетам?
Что стало хуже или лучше?
```

Compare the two newest snapshots by card ID and `contentHash`. Report new, changed, moved, completed, archived, reopened, and newly stale cards. If nothing material changed, say so plainly.

### Focused review

Trigger examples:

```text
Разбери проблемы с транспортом
Найди тикеты, похожие на <problem>
Что сильнее всего раздражает тестеров?
```

Use the newest snapshot and restrict conclusions to the requested topic. Mention adjacent clusters only when they materially affect the conclusion.

## Priority model

Give each issue cluster a transparent 0-100 priority score. The score is a decision aid, not an automatic command to the developers.

| Signal | Points | Guidance |
| --- | ---: | --- |
| Severity and blocking impact | 0-30 | Crash, inability to play, irreversible loss, blocked core flow |
| Independent repetition | 0-20 | Multiple distinct tickets/reporters describing the same underlying issue |
| Regression or failed retest | 0-15 | Returned after a fix, repeated QA "нужна доработка", reopened behavior |
| Reach and frequency | 0-15 | Broadly encountered or repeatedly triggered in ordinary play |
| Stagnation | 0-10 | Important open issue with no meaningful movement or response |
| Frustration | 0-10 | Wasted time, lost progress, confusing recovery, repeated failed attempts |

Also provide a separate confidence value: high, medium, or low. Missing reproduction steps lower confidence, not necessarily priority.

Do not equate comment volume or emotional language with severity. Do not merge tickets merely because they share a noun or game area. A duplicate cluster requires a plausible shared symptom and trigger; otherwise describe it as a broader theme.

## Questions to answer

For every full review, determine:

1. What deserves developer attention first, and why?
2. Which problems block play or risk lost progress/items/currency?
3. Which reports likely describe the same root problem?
4. Which fixes failed QA or returned for more work?
5. Which important tickets are stalled?
6. What produces the most tester frustration?
7. What information is missing for confident diagnosis?
8. What are the next three to seven concrete developer actions?

## Full report contract

Keep the answer concise enough to scan in a team discussion. Use this order:

1. **Executive summary** — the state of QA in 5-8 sentences.
2. **Attention now** — 3-7 ranked issue clusters with score, confidence, evidence, and next action.
3. **What changed** — only when an earlier snapshot exists.
4. **Recurring themes and likely duplicates** — cluster reasoning plus card links.
5. **Failed retests and stalled work**.
6. **Missing information** — reproduction steps, logs, affected scope, or unclear ownership.
7. **Recommended developer actions** — concrete, ordered, and small enough to act on.

For each ranked issue, use this compact shape:

```text
Issue — 82/100, confidence: high
Why: impact and repetition in one or two sentences.
Evidence: Trello links.
Next: one concrete investigation or implementation step.
```

Do not fabricate exact player counts, frequency, root causes, or chronology. When evidence is weak, label the statement as a hypothesis.

## Delta report contract

Use this shorter order:

1. Material change summary.
2. New or newly discovered problems.
3. Priority increases/decreases and why.
4. Moves, completions, reopenings, and failed retests.
5. Updated next actions.

If a change is merely textual cleanup with no change in meaning, omit it from the material summary.
