# Entity Enrichment Tiers

This doc defines the canonical enrichment ladder for entity pages. The naming
is intentionally simple:

- **Stub**
- **Web-enrich**
- **Full dossier**

The older Tier 1/2/3 wording still maps to these levels, but the new names are
what the brain docs should use going forward.

## The Ladder

| Tier | Spend | When to use | What to capture |
| --- | --- | --- | --- |
| Stub | 1-2 calls | Minor mentions and low-signal pages | Minimal safe signal, source-only facts, enough to create or update the page |
| Web-enrich | 3-5 calls | Notable people and companies with enough signal to justify background research | Web search, social search, and brain cross-reference |
| Full dossier | 10-15 calls | Key people, inner-circle collaborators, and important companies | Full pipeline across meeting history, contacts, web, social, and structured enrichment APIs |

## Practical Rule

If the page is thin and the entity is important, enrich it. If the page is
thin and the entity is not important, keep the capture sparse and preserve the
raw signal for later.

## Back-Compat Mapping

- Stub = old Tier 3
- Web-enrich = old Tier 2
- Full dossier = old Tier 1

## What Goes Where

- **Stub** writes the minimum needed for a valid page and preserves the
  interaction trail.
- **Web-enrich** adds public context and corroboration.
- **Full dossier** produces the most complete portrait and should update the
  related company or founder pages too.

## Verification

1. Capture a low-priority mention and confirm the page stays stub-level.
2. Capture a notable person and confirm web + social context appears.
3. Capture a key collaborator and confirm the page reads like a full dossier.
4. Re-run enrichment within a week and confirm the system skips the page when
   no new signal is available.
