# Entity Types and Auto-Linking

This doc is the compact contract for how GBrain links entities across note
types. It defines the canonical relation vocabulary, the frontmatter fields
that map to each relation, and the fallback behavior for body wikilinks.

## Canonical Relations

| Relation | Meaning | Typical note types | Typical fields |
| --- | --- | --- | --- |
| `works_at` | person ↔ company affiliation | `person`, `company` | `company`, `companies`, `key_people` |
| `founded` | person → company founding edge | `person` | `founded` |
| `invested_in` | investor ↔ deal/company investment edge | `company`, `deal` | `investors` |
| `led_round` | lead investor role on a financing round | `deal` | `lead` |
| `attended` | person → meeting attendance edge | `meeting` | `attendees` |
| `related_to` | general cross-note adjacency | any note type | `related`, `see_also` |
| `mentions` | narrative mention with no stronger typed edge | any note type | body wikilinks, prose mentions |
| `advises` | advisor ↔ company/project guidance edge | `person`, `company` | — (prose/context inference) |

## Auto-Linking Order

GBrain resolves entity references in this order:

1. Read frontmatter fields that map to typed relations.
2. Resolve canonical note slugs in body wikilinks.
3. Fall back to `mentions` when the prose only signals a loose reference.

This keeps durable edges in frontmatter and narrative references in the body
without losing either signal.

## Recommended Syntax

Use frontmatter for typed edges:

```yaml
---
title: Alice Example
type: person
context: business
tags: [engineering, acme-example]
company: companies/acme-example
---
```

Use wikilinks for narrative references:

```markdown
Alice has also worked closely with [[companies/acme-example]] on the API migration.
```

## Sample Person Page

```markdown
---
title: Alice Example
type: person
context: business
tags: [engineering, acme-example]
company: companies/acme-example
---

# Alice Example

VP Engineering at Acme Example.

## State
- **Company:** Acme Example
- **Role:** VP Engineering

---

## Timeline
- **2026-07-16** | First captured as a typed person page.
```

When this page is written, the `company` field becomes a `works_at` edge
automatically. If the body also mentions `[[companies/acme-example]]`, that
reference is preserved as a narrative mention and can still be upgraded by the
extractor when the surrounding prose is strong enough.

## Verification

1. Create a person page with `company: companies/acme-example`.
2. Run the auto-link path.
3. Confirm the graph contains a `works_at` edge to the company page.
4. Add a body wikilink to the same company and confirm the mention remains
   linked even if the typed edge is already present.
