# Entity Enrichment Tiers

This doc defines the canonical ladder for the **agent-orchestrated enrichment
skill**. It is not a description of the native `gbrain enrich` command. The
naming is intentionally simple:

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

Importance controls the permitted spend only. It never grants access to a
private source, expands an agent's authority, or overrides the approval
boundary.

## Authorization and Privacy Boundary

- Use only sources the user has authorized and the running agent is permitted
  to access for this purpose.
- Minimize collection to facts needed for the stated task. Do not collect
  sensitive personal data merely because an entity qualifies for a higher
  spend tier.
- Mediate credentials through the approved credential gateway; agents must not
  expose or persist raw secrets.
- Preserve source attribution and access sensitivity. Do not copy private
  source material into a broader-access page.
- Apply the governing retention and deletion rules to raw responses and
  derived facts. A full dossier is not permission for indefinite retention.

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

## Native `gbrain enrich`

The native CLI is a separate, brain-internal synthesis path. It gathers
existing GBrain evidence and performs one model synthesis call; it does not
perform the web, social, contacts, meeting, or structured-API lookups listed in
the agent ladder. By default it skips pages whose `enriched_at` timestamp is
less than 30 days old. Operators can change that window with
`--reenrich-after`.

## Verification

1. Capture a low-priority mention and confirm the page stays stub-level.
2. Capture a notable person and confirm web + social context appears.
3. Capture a key collaborator and confirm the page reads like a full dossier.
4. Before repeating the agent-driven workflow within a week, check source
   `fetched_at` timestamps and skip it when there is no new signal. This is an
   agent workflow rule, not a runtime-enforced freshness gate.
5. Run native `gbrain enrich` twice and confirm its `enriched_at` recency guard
   uses the configured `--reenrich-after` window (30 days by default).
