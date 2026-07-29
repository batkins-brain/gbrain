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
| `advises` | advisor ↔ company/project guidance edge | `person`, `company`, `project` | `advises`, `advisors`, or explicit advisor prose |

## Auto-Linking Order

GBrain resolves entity references in this order:

1. Resolve canonical note slugs in markdown links and wikilinks.
2. Resolve bare canonical slugs in the body.
3. Read frontmatter fields that map to typed relations.

Every target must resolve to an existing page in the active source. An
unresolved frontmatter value is reported in the auto-link result and does not
create a dead edge. Frontmatter and body references have separate provenance,
so a durable typed edge and a narrative reference can coexist.

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

When this page is written locally and auto-linking is enabled, the `company`
field becomes a `works_at` edge if `companies/acme-example` already exists in
the active source. If the target is missing, GBrain reports the unresolved
frontmatter value and creates no edge. If the body also mentions
`[[companies/acme-example]]`, that reference is preserved with body-link
provenance separately from the frontmatter edge.

## Verification

1. Create `companies/acme-example`, then create a person page with
   `company: companies/acme-example`.
2. Run the trusted local `put_page` auto-link path.
3. Confirm the graph contains a frontmatter-sourced `works_at` edge.
4. Add a body wikilink to the same company and confirm both provenance records
   remain linked.
5. Repeat with a nonexistent company and confirm the response reports the
   unresolved field and creates no dead edge.
