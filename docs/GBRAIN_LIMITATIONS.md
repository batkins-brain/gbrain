# GBrain Limitations and Rough Edges

GBrain is useful because it combines deterministic storage/search/indexing with
LLM-assisted synthesis, enrichment, and maintenance. Treat those two classes of
features differently. Deterministic features should be expected to be repeatable
and testable; prompt-based features should be reviewed, budgeted, and run with a
rollback path.

## Deterministic Features

These features are primarily code and database behavior. They can still have
bugs, but failures should be reproducible and debuggable from logs, database
state, or CLI output.

- **Storage and migrations** — pages, chunks, links, facts, sources, and related
  indexes live in the configured engine (PGLite for local/small installs,
  Postgres + pgvector for larger or shared installs).
- **Search and retrieval** — keyword/vector/hybrid search returns ranked pages or
  chunks from indexed content. Quality depends on ingestion coverage, embedding
  configuration, and source freshness.
- **Link extraction from explicit references** — markdown links, wikilinks, and
  supported typed frontmatter fields can be parsed into graph edges without an
  LLM call.
- **Schema checks and dry-run reports** — commands that count pages, preview
  schema changes, or show would-apply/would-delete output are intended to be
  deterministic previews.
- **Backups and exports** — database and repo-level backups are operational
  procedures, not model judgments.

## Prompt-Based Features

These features rely on an LLM following multi-step instructions. They are
powerful, but should be treated as assisted work that needs model choice,
provenance, review, and cost controls.

- **Dream cycle** — overnight consolidation, contradiction surfacing, synthesis,
  and health-improvement loops depend on the model's ability to follow long
  procedures and preserve nuance.
- **Entity enrichment** — person/company enrichment can call web, social,
  meeting, contact, or structured data sources, then synthesize a page update.
  It may miss context, over-summarize, or produce stale conclusions if sources
  are incomplete.
- **Auto-linking beyond explicit syntax** — deterministic extraction handles
  explicit links/frontmatter, but prose-based relation inference and upgrades
  from loose mentions to stronger typed edges should be reviewed.
- **Synthesis and gap analysis** — answers generated from search results may be
  well-cited but can still omit relevant pages, mis-rank evidence, or overstate
  confidence.
- **Schema evolution suggestions** — proposed page types, field migrations, and
  resolver changes should be dry-run and reviewed before being applied broadly.

## Known Constraints

### Version instability around v0.10-v0.19

The v0.10 through v0.19 era introduced substantial graph, frontmatter,
extraction, and migration behavior. Brains that crossed several of those
versions may carry older assumptions in extracted links, page types, or schema
metadata.

Practical guidance:

- Run the current doctor/verify commands after upgrades.
- Re-run link extraction or schema sync when release notes or doctor output say
  an extractor/version watermark changed.
- Treat old graph edges and legacy page types as candidates for audit, not as
  automatically canonical truth.
- Keep migration logs and backups until the upgraded brain has been queried and
  spot-checked.

### Concurrent-write risk

GBrain has code paths designed for batch updates, background jobs, and autonomous
maintenance. Concurrent writes can still be risky when multiple agents, cron
jobs, sync jobs, or manual edits touch the same page set at the same time.

Practical guidance:

- Avoid running multiple broad maintenance jobs against the same brain/source at
  once.
- Prefer append-only timelines and database-backed facts for event history.
- For bulk operations, use dry-run first and then apply in bounded batches.
- If the brain is repo-backed, pull/rebase before a write pass and inspect diffs
  before publishing.

### Source and visibility boundaries

Search quality depends on which brain and source are active, which pages have
been ingested, and which caller is allowed to read them. A missing result can
mean the fact is absent, stale, in another source, or outside the caller's
visibility.

Practical guidance:

- Confirm the active brain/source before assuming a page does not exist.
- Prefer cited answers that name source pages.
- When a query matters, inspect the underlying pages instead of trusting only the
  synthesized answer.

## Model Recommendation

Use **Claude Opus or an equivalent frontier model** for reliable multi-step
instructions, especially for:

- dream-cycle review or consolidation;
- full-dossier entity enrichment;
- broad schema migrations or resolver rewrites;
- multi-page synthesis where omissions would be costly;
- any maintenance run that will write many pages.

Smaller or cheaper models can be useful for deterministic command execution,
simple formatting, first-pass summaries, or low-risk stub enrichment, but should
not be the default for high-impact autonomous maintenance.

## Safety Practices

### Daily backup

Keep a daily backup of the brain database and any repo-backed markdown source.
For PGLite, back up the configured data directory. For Postgres/Supabase, use the
provider's snapshot/export path. For repo-backed vaults, keep Git history and a
remote copy in addition to database backups.

Minimum daily backup checklist:

1. Capture the database or provider snapshot.
2. Preserve the markdown repo or source tree state.
3. Record the GBrain version and active source/brain identifiers.
4. Confirm the backup is restorable, not just present.

### Dry-run mode for maintenance

Before broad maintenance, run the relevant dry-run/preview mode and read the
would-change output. This applies to schema sync, extraction backfills, type
unification, cleanup, imports, and dream-cycle remediation plans.

Use dry-run output to answer:

- Which brain/source will be touched?
- How many pages/facts/links would change?
- Are there surprising prefixes, types, or target slugs?
- Is the cost and runtime acceptable?

Do not skip dry-run just because an agent is confident.

### Rollback procedure

Have the rollback path ready before applying a broad write.

1. Stop other writers, cron jobs, and agents touching the same brain/source.
2. Save the failing command, logs, GBrain version, and affected source/brain.
3. If repo-backed markdown changed, inspect `git diff` and revert only the
   affected files or restore the pre-run branch/snapshot.
4. If database state changed, restore from the latest verified backup or provider
   snapshot.
5. Re-run doctor/verify after rollback.
6. Re-apply only in a smaller batch after the root cause is understood.

## Operator Rule

For anything that can rewrite many pages, facts, links, or schema records:

1. verify the active brain/source;
2. take or confirm a recent backup;
3. run dry-run/preview;
4. use a frontier model for prompt-based judgment;
5. apply in bounded batches;
6. inspect diffs/results before considering the run complete.
