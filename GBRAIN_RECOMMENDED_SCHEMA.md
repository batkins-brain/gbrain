# GBRAIN Recommended Schema

This is the cold-start contract for the canonical GBrain vault. An AI agent that
has never seen the vault before should be able to scaffold and maintain the
entire structure from this file alone.

## Scope and invariants

- The vault is a markdown knowledge base with one primary home for each page.
- Top-level folders are MECE by primary subject. Cross-links preserve adjacency;
  duplicate pages do not.
- File and folder names are stable IDs. Changing a slug is an identity migration,
  not cosmetic cleanup.
- Compiled truth lives at the top of a page. Timeline/evidence lives below a
  horizontal rule (`---`) when the page type benefits from history.
- Frontmatter stores queryable metadata. Body text stores synthesis and evidence.

## Canonical top-level folders

Only these top-level folders are canonical for this recommended schema:

```text
brain/
├── GBRAIN_RECOMMENDED_SCHEMA.md
├── RESOLVER.md
├── people/
├── companies/
├── concepts/
├── projects/
├── meetings/
├── journal/
├── _templates/
└── _dashboards/
```

| Folder | Intent | Filename pattern | Required frontmatter |
| --- | --- | --- | --- |
| `people/` | One canonical page per human being. Capture who they are, relationship/context, current state, and interaction timeline. | `first-last.md`; disambiguate as `first-last-company.md` | `title`, `type`, `context`, `tags` |
| `companies/` | One canonical page per company, organization, fund, agency, or institution. | `company-name.md`; disambiguate as `company-name-domain.md` | `title`, `type`, `context`, `tags` |
| `concepts/` | Reusable ideas, frameworks, terms, principles, and explainers that can be taught or cited. | `concept-name.md` | `title`, `type`, `context`, `tags` |
| `projects/` | Active work with a goal, owner, scope, repo, delivery surface, or tracked outcome. | `project-name.md` | `title`, `type`, `context`, `tags` |
| `meetings/` | Dated meeting/event records: attendees, agenda, decisions, action items, and evidence. | `YYYY-MM-DD-topic.md` | `title`, `type`, `context`, `tags`, `date` |
| `journal/` | Dated personal or reflective logs and day notes. Use for first-person state, observations, and thinking that is not an entity/project record. | `YYYY-MM-DD.md` or `YYYY-MM-DD-topic.md` | `title`, `type`, `context`, `tags`, `date` |
| `_templates/` | Reusable scaffolds for agents and humans. Templates are not knowledge pages. | `person.md`, `company.md`, `concept.md`, `project.md`, `meeting.md`, `journal.md`, `dashboard.md` | None required; templates should show sample frontmatter |
| `_dashboards/` | Curated indexes, status views, rollups, and navigation hubs. Dashboards summarize and link; they do not replace source pages. | `topic-dashboard.md` or `status-dashboard.md` | `title`, `type`, `context`, `tags` |

## Folder resolver rules

### `people/`

Use `people/` when the primary subject is a human. Include role, organization,
relationship, key context, communication notes, and a timeline of important
interactions. If the note is about a meeting with the person, create the meeting
in `meetings/` and link back to the person.

Does not belong here: companies, teams as organizations, generic archetypes, or
meeting transcripts.

### `companies/`

Use `companies/` when the primary subject is an organization: company, fund,
school, government office, nonprofit, community, or named internal org. Link to
the people and projects associated with it.

Does not belong here: individual employees, one-off meetings, or broad concepts
such as “AI safety”.

### `concepts/`

Use `concepts/` for reusable knowledge: mental models, definitions, frameworks,
technical patterns, strategies, operating principles, and repeatable lessons. A
concept page should be useful outside the event where it was learned.

Does not belong here: active delivery work (`projects/`), dated event records
(`meetings/`), or private reflection (`journal/`).

### `projects/`

Use `projects/` for active work: something being built, investigated, shipped,
maintained, or explicitly tracked. A project page should state current status,
owner, desired outcome, next steps, and source links.

Does not belong here: reusable ideas with no active owner (`concepts/`), meeting
minutes (`meetings/`), or company profiles (`companies/`).

### `meetings/`

Use `meetings/` for dated interactions: calls, standups, planning sessions,
reviews, interviews, 1:1s, councils, and decision meetings. Record attendees,
agenda, decisions, action items, and links to related pages.

Does not belong here: evergreen person/company summaries or private daily notes.

### `journal/`

Use `journal/` for dated personal notes, reflections, daily logs, and subjective
observations. Journal pages may link to entities and projects, but their primary
home is the date/state of the author.

Does not belong here: official meeting records, durable project state, or entity
profiles.

### `_templates/`

Use `_templates/` for scaffolds only. Template files should be safe to copy into
their target folder and fill in. Do not treat template files as source facts.

### `_dashboards/`

Use `_dashboards/` for navigation and status rollups. Dashboards should be short,
link-heavy, and explicit about scope. Avoid duplicating canonical facts that live
on source pages.

## Naming conventions

1. Use `kebab-case` for every markdown filename and folder below the top level.
2. Use lowercase ASCII letters, numbers, and hyphens only.
3. Do not use spaces, underscores, camelCase, punctuation, or emoji in slugs.
4. The filename without `.md` is the canonical slug and stable page ID.
5. Prefer human-readable slugs over opaque IDs: `people/jane-doe.md`, not
   `people/p123.md`.
6. Disambiguate collisions with the smallest stable qualifier:
   `people/alex-chen-openai.md`, `companies/acme-health.md`.
7. Dated pages begin with ISO date: `meetings/2026-07-23-council-sync.md`.
8. Rename only when identity is wrong. If a name changes, usually keep the slug
   and add `aliases` in frontmatter.

## Required frontmatter

Every content page must begin with YAML frontmatter. Required baseline fields:

```yaml
---
title: Human-readable title
type: person
context: business
tags: []
---
```

Allowed `context` values:

- `business`
- `personal`
- `both`

Allowed `type` values in this schema:

- `person`
- `company`
- `concept`
- `project`
- `meeting`
- `journal`
- `dashboard`

Use `tags` for search/grouping. Tags are lowercase kebab-case strings. Prefer a
small stable set over many near-duplicates.

### `people/` frontmatter

```yaml
---
title: Jane Doe
type: person
context: business
tags: [person]
aliases: []
company: companies/example-company
relationship: unknown
status: active
---
```

Required: `title`, `type: person`, `context`, `tags`.

Recommended: `aliases`, `company`, `relationship`, `status`, `last_contacted`,
`source_confidence`.

### `companies/` frontmatter

```yaml
---
title: Example Company
type: company
context: business
tags: [company]
aliases: []
website: https://example.com
industry: unknown
stage: unknown
---
```

Required: `title`, `type: company`, `context`, `tags`.

Recommended: `aliases`, `website`, `industry`, `stage`, `hq`, `status`.

### `concepts/` frontmatter

```yaml
---
title: Compound Growth
type: concept
context: business
tags: [concept]
domains: []
related_pages: []
---
```

Required: `title`, `type: concept`, `context`, `tags`.

Recommended: `aliases`, `domains`, `related_pages`, `maturity`, `source_confidence`.

### `projects/` frontmatter

```yaml
---
title: Example Project
type: project
context: business
tags: [project]
status: active
owner: unknown
related_people: []
related_companies: []
---
```

Required: `title`, `type: project`, `context`, `tags`.

Recommended: `status`, `owner`, `due_date`, `repo`, `related_people`,
`related_companies`, `related_concepts`.

### `meetings/` frontmatter

```yaml
---
title: 2026-07-23 Example Meeting
type: meeting
context: business
tags: [meeting]
date: 2026-07-23
attendees: []
related_projects: []
---
```

Required: `title`, `type: meeting`, `context`, `tags`, `date`.

Recommended: `attendees`, `related_people`, `related_companies`,
`related_projects`, `location`, `source`.

### `journal/` frontmatter

```yaml
---
title: 2026-07-23 Journal
type: journal
context: personal
tags: [journal]
date: 2026-07-23
privacy: private
---
```

Required: `title`, `type: journal`, `context`, `tags`, `date`.

Recommended: `privacy`, `themes`, `mood`, `related_projects`, `related_concepts`.

### `_dashboards/` frontmatter

```yaml
---
title: Project Dashboard
type: dashboard
context: business
tags: [dashboard]
scope: projects
refresh_interval: ad-hoc
---
```

Required: `title`, `type: dashboard`, `context`, `tags`.

Recommended: `scope`, `filters`, `refresh_interval`, `owner`.

### `_templates/` frontmatter

Templates may omit live metadata, but each template should include sample
frontmatter for the target type. Keep placeholders obvious, for example
`REPLACE_ME`, `YYYY-MM-DD`, and `unknown`.

## Page body conventions

For entity and project pages, use this two-layer shape:

```markdown
# Page Title

> Executive summary: current compiled truth in one short paragraph.

## State
- **Status:** active | inactive | unknown
- **Context:** key facts that should be true now

## Open Threads
- [ ] Question, risk, or next action that is still live

## See Also
- [[people/jane-doe]]
- [[projects/example-project]]

---

## Timeline

### YYYY-MM-DD — Source or event title
- Evidence-backed note with source/provenance.
```

Meeting pages may use:

```markdown
# YYYY-MM-DD Topic

## Attendees
- [[people/jane-doe]]

## Agenda
- Topic

## Decisions
- Decision and owner

## Action Items
- [ ] Action — owner, due date

## Notes
- Evidence-backed notes
```

Journal pages may be looser, but should still use clear headings and links when
they mention durable people, companies, concepts, or projects.

## Link conventions

1. Prefer canonical vault links: `[[people/jane-doe]]`,
   `[[companies/example-company]]`, `[[concepts/compound-growth]]`.
2. Link by path-qualified slug, not bare ambiguous names.
3. Use markdown links for external URLs or when a tool requires relative paths.
4. Link a meaningful first mention of each durable entity in a page.
5. Meeting pages should link every important attendee and related project/company.
6. Entity pages should include backlinks in `## See Also`, `## Related`, or
   timeline entries when another page materially changes context.
7. Do not create a duplicate page when a canonical page already exists. Add an
   alias or backlink to the existing page instead.
8. If a page mentions a person/company/project/concept often enough that an agent
   should retrieve it later, make the link explicit.

## Typed relations and auto-linking

GBrain maintains a typed relationship graph from frontmatter and body links. Use
frontmatter when the relationship is durable and queryable; use body wikilinks
when the page merely mentions another entity in prose.

Canonical relation types:

| Relation | Direction | Meaning | Frontmatter / syntax that creates it |
| --- | --- | --- | --- |
| `works_at` | person → company | Employment, advisory operating role, or other primary affiliation. | `company: companies/example-company`, `companies: [...]` on a person page; `key_people: [...]` on a company page creates incoming person → company edges. |
| `founded` | person → company | Founder/co-founder relationship. | `founded: companies/example-company` on a person page, or prose such as “Jane founded [[companies/example-company]]”. |
| `invested_in` | investor → company/deal | Investment, funding, lead round, or portfolio relationship. | `investors: [...]` on a company or deal page; investment verbs near `[[companies/example-company]]`. |
| `advises` | person → company/project | Advisor, consultant, advisory board, or formal guidance relationship. | `advisors: [...]` on a company/project page creates incoming advisor edges; `advises: [...]` on a person page creates outgoing edges; advisor verbs near a wikilink. |
| `attended` | person → meeting | Person attended a dated meeting/event. | `attendees: [...]` on a meeting page creates incoming person → meeting edges. |
| `related_to` | page → page | General durable adjacency when no more specific relation is correct. | `related: [...]` or `see_also: [...]` on any page. |
| `mentions` | page → page | Narrative reference with no stronger typed edge. | Body wikilinks such as `[[people/jane-doe]]` or markdown links when no typed relation is inferred. |

Auto-linking rules for agents and importers:

1. Resolve every frontmatter relation value to an existing canonical slug before
   writing an edge. Do not create dangling graph edges.
2. Preserve subject semantics. If `companies/example-company.md` has
   `key_people: [people/jane-doe]`, the edge is `people/jane-doe --works_at-->
   companies/example-company`, not the reverse.
3. Body links are scanned after code blocks are ignored. Verb context near a
   link can upgrade `mentions` to `works_at`, `founded`, `invested_in`, or
   `advises`.
4. Meeting pages default person links to `attended` unless the link is explicitly
   a source or another non-attendee relation.
5. Use `related_to` only when the relationship matters but is not employment,
   founding, investment, advising, attendance, source, or a plain mention.

### Sample typed edge

`people/jane-doe.md`:

```yaml
---
title: Jane Doe
type: person
context: business
tags: [person]
company: companies/example-company
---
```

This frontmatter creates an automatic typed edge:

```text
people/jane-doe --works_at--> companies/example-company
```

The body should still link the company where it is useful to a reader:

```markdown
Jane Doe is CTO of [[companies/example-company]].
```

## Entity enrichment tiers

Use the lightest enrichment tier that satisfies the user's need. Thin, sourced
pages are better than expensive dossiers for low-signal entities.

| Tier | Name | When to use | Required output |
| --- | --- | --- | --- |
| 1 | `stub` | New entity with limited context or a single mention. | Canonical file, required frontmatter, one-sentence summary if known, aliases/source note, and links from the originating page. |
| 2 | `web-enrich` | Entity is relevant enough to need current public context. | Stub fields plus web/public-source facts, cited timeline entries, current role/company or company stage, and obvious backlinks. |
| 3 | `full-dossier` | High-value person/company/project, board briefing, investment/customer context, or repeated interactions. | Web-enrich output plus relationship history, beliefs/strategy/context, open threads, confidence labels, raw sidecars for external data, and reciprocal typed edges. |

Escalate from `stub` → `web-enrich` → `full-dossier` only when the entity's
importance or the user's task justifies the extra lookup cost. User corrections
override all tiers and should be applied immediately with provenance.

## Cold-start scaffolding instructions

When creating a new vault from scratch:

1. Create the eight canonical top-level folders:
   `people/`, `companies/`, `concepts/`, `projects/`, `meetings/`, `journal/`,
   `_templates/`, `_dashboards/`.
2. Create `RESOLVER.md` at the vault root. It should tell agents to choose one
   primary home, consult this schema, and fall back to asking for clarification
   rather than inventing a ninth top-level folder.
3. Add a `README.md` resolver inside each top-level folder with:
   - what belongs here,
   - what does not belong here,
   - naming examples,
   - required frontmatter for that folder.
4. Add template files in `_templates/` for each content type.
5. Add initial dashboards in `_dashboards/`:
   - `_dashboards/people-dashboard.md`
   - `_dashboards/company-dashboard.md`
   - `_dashboards/project-dashboard.md`
   - `_dashboards/meeting-dashboard.md`
6. Validate every markdown page:
   - filename is kebab-case,
   - frontmatter exists where required,
   - `type` matches the folder,
   - `context` is one of `business`, `personal`, or `both`,
   - durable entities are linked with path-qualified slugs.

## Example resolver decision tree

1. Is the primary subject a named human? Use `people/`.
2. Is it a named organization? Use `companies/`.
3. Is it an active effort with an owner/outcome? Use `projects/`.
4. Is it a dated interaction or event record? Use `meetings/`.
5. Is it first-person dated reflection or daily state? Use `journal/`.
6. Is it reusable knowledge or a teachable framework? Use `concepts/`.
7. Is it a scaffold? Use `_templates/`.
8. Is it an index, rollup, or navigation view? Use `_dashboards/`.
9. If none fit, stop and ask for a schema decision instead of creating a new
   top-level folder.

## Operating rule

When in doubt, preserve one canonical home per subject and cross-link everything
else. The vault should be readable cold by an AI agent, predictable for humans,
and strict enough that automated scaffolding does not fragment the knowledge
graph.