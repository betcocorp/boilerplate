# Formulation-variant aliasing rules — concentrate / RTU / "Dual" (B0-486)

Rule record for `rag.product_alias` / `rag.entity` deciding when a formulation variant of a
product name (concentrate vs. ready-to-use, "Dual", "Ultra", regional overseas builds, etc.)
should be aliased into an **existing** `product_line_key` versus modeled — and aliased — as its
**own, separate** `product_line_key`. Written ahead of the B0-484 corpus scan and the B0-487 admin
review queue that will consume it; applied here only to the two named, already-understood examples
from the epic (pH7Q family, HAN), not corpus-wide.

**This rule requires Tom's (the ticket owner's) read-through and confirmation before it is used as
the basis for bulk-approving any B0-484 corpus-scan-sourced formulation-variant alias through the
B0-487 review queue.** Nothing below authorizes bulk application yet.

## The rule

The regulated fields on `rag.product_line_fact` (`dilution_oz_per_gal` / `dilution_display`,
`epa_registration`, `contact_time_seconds`) are the ground truth for whether two candidate variants
are actually the same formulation. Per the org-wide regulated-data rule, these values are compared
**exactly as stored** — no rounding, converting, or inferring is used to force a match or a
mismatch.

| Condition on `rag.product_line_fact` for both candidates | Action |
|---|---|
| Both have fact rows, **and** EPA registration and dilution agree | May share an alias / `product_line_key`. |
| Both have fact rows, **and** EPA registration or dilution **disagree** | **Never merge.** Keep separate `product_line_key`s, separate alias rows. |
| **No fact data exists** for one or both candidates | Default to **NOT merging**. Flag as an open data gap requiring a regulated-data backfill before the rule can be fully validated for that pair — do not infer or estimate what the EPA reg/dilution "probably" is. |

A name looking like a formulation-variant pair (e.g. sharing a brand root, differing by
"concentrate"/"RTU"/"Dual"/"Ultra") is never sufficient on its own to merge or split — the
`product_line_fact` comparison above is the only basis for the decision.

## Applying the rule: pH7Q family

Queried live against `rag.product_line_fact` (joined to `rag.entity` on `product_line_key`),
2026-08-16. **Correction to the epic's working assumption:** this table is not empty for the pH7Q
family — three of the four rows below carry real regulated data. Values are transcribed exactly as
stored; nothing here is rounded or converted.

| Product line (`product_line_key`) | Entity / tier | `epa_registration` | `contact_time_seconds` | `dilution_display` | `dilution_oz_per_gal` |
|---|---|---|---|---|---|
| pH7Q Neutral Disinfectant (`FBDC9386-AA70-4DD1-9C8D-3EB46C4AFB94`) | product-tier "pH7Q" (product_key `31604`) | `47371-131-4170` | `60` | `1:64` | null |
| pH7Q Neutral Disinfectant (`FBDC9386-AA70-4DD1-9C8D-3EB46C4AFB94`) | product-tier "pH7Q Sample" (product_key `31612`) | `47371-131-4170` | `60` | `1:64` | null |
| pH7Q Neutral Disinfectant (`FBDC9386-AA70-4DD1-9C8D-3EB46C4AFB94`) | product_line-tier "Neutral pH disinfectant" | null | null | `1:64` | `2.000` |
| pH7Q Ultra (`168549A1-B75F-4D00-B5C1-087A95C317D9`) | product-tier "pH7Q Ultra" (product_key `32504`) | `47371-129-4170` | `120` | `1:256` | null |
| pH7Q Ultra (`168549A1-B75F-4D00-B5C1-087A95C317D9`) | product_line-tier "Concentrated Neutral Disinfectant Cleaner" | null | null | `1:256` | `0.5` |
| pH7Q Dual (`69171DB7-F490-4C87-A67E-C1F928768D68`) | product_line-tier "Concentrated Neutral Disinfectant Cleaner" | **null** | **null** | `1:256` | `0.500` |
| pH7Q Dual (`69171DB7-F490-4C87-A67E-C1F928768D68`) | *(no product-tier row exists for any of its 10 product entities)* | — | — | — | — |

### What this shows, under the rule above

- **pH7Q Neutral Disinfectant vs. pH7Q Ultra: both have product-tier fact rows, and they disagree.**
  EPA registration `47371-131-4170` vs. `47371-129-4170` — different registrations, different
  contact time (`60` vs. `120` seconds), different dilution (`1:64` vs. `1:256`). This is the
  rule's **"disagree → never merge"** branch, now backed by real data rather than assumed absence
  of data. These two must never share an alias/`product_line_key` row.
- **pH7Q Dual: no product-tier fact data exists at all** (no `epa_registration`, no
  `contact_time_seconds`, and no product-tier `dilution_display`/`dilution_oz_per_gal` — only a
  product_line-tier row that happens to carry the same `1:256` dilution string as Ultra's
  product-line-tier row, with no EPA registration to compare). This is the rule's **"insufficient
  data → default don't merge, flag as a gap"** branch. Do not read the shared `1:256` display value
  as evidence Dual and Ultra are the same formulation — a naked dilution match with no EPA
  registration on one side is exactly the kind of inference the regulated-data rule prohibits.
  **Open data gap:** pH7Q Dual needs an SDS/label-sourced product-tier `product_line_fact` backfill
  (EPA registration, contact time, dilution) before its distinctness from Ultra can be confirmed by
  data rather than by naming convention and existing entity modeling alone.

### Conclusion for pH7Q family

`pH7Q Neutral Disinfectant`, `pH7Q Dual`, and `pH7Q Ultra` are three genuinely distinct
`product_line_key`s. They are already correctly modeled as such in `rag.entity`, and already
correctly alias-mapped by full title (each has a verified, `title`-sourced `rag.product_alias` row
for its full display name). **No `product_alias` row should ever merge these three
`product_line_key`s under one row.** B0-485 additionally seeds the bare acronym `"pH7Q"` as three
separate rows (one per line, all `verified = true`), deliberately creating a 3-way ambiguity for
that bare term. `resolveProductEntityByName` (`~/lib/rag/entity-context.ts`) only resolves an
ambiguous `alias_norm` when exactly one candidate product line is `verified`
(`resolveVerifiedTiebreak`); with all three verified, it correctly returns null (ambiguous) instead
of silently falling through to an unrelated ILIKE title match — this is the intended, safe outcome,
not a defect.

## Applying the rule: HAN (Hard As Nails Floor Finish)

`Hard Film Floor Finish` (`product_line_key = DBF2B1E5-FD1A-4E42-A3A5-D7C8F5C3B671`, commonly
called "Hard As Nails Floor Finish", 4 SKUs) has exactly one `product_line_fact` row, on the
product_line-tier entity: `dilution_display = "Ready to use"`, `coverage_sq_ft = 2000`,
`product_application = "floor-finish"`, `epa_registration = null`, `contact_time_seconds = null`
(expected and correct — a floor finish is not an EPA-registered disinfectant, so no EPA field is
expected here). There is no competing formulation-variant `product_line_key` for HAN in the data —
it is a single product line with multiple SKUs, not a concentrate/RTU/Dual-style variant pair — so
the merge/split branch of this rule does not apply to HAN. B0-485 adds only a bare-acronym alias
(`"HAN"`) into this single existing line; no variant decision is needed.

## Open items

- **Needs Tom's review** before this rule is used to bulk-approve any B0-484 corpus-scan-sourced
  formulation-variant alias candidate through the B0-487 review queue.
- **Regulated-data gap:** pH7Q Dual has no product-tier `product_line_fact` row (no EPA
  registration, no contact time, no product-tier dilution). Backfilling this from its SDS/label is
  a prerequisite to fully validating the rule's conclusion for that specific line with data, though
  the entity model and existing verified aliases already treat it as distinct.
