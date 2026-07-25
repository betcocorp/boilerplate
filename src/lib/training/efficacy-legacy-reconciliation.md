# B0-225 — Legacy Efficacy Sheet Reconciliation

Reconciles the 24 legacy markdown sheets (`efficacy/markdown/legacy/*.md`, product-code-keyed)
against the 70 new formula-keyed reports (`efficacy/markdown/hygiene-skin-care/**`, M000xxx
formulas) and the B0-223 version table. Full machine-readable detail (per-file reason strings)
lives in `efficacy-legacy-reconciliation.json` alongside this file.

## Headline finding

**The legacy 24 and the new 70 cover entirely different product categories — zero overlap.**
The legacy sheets are general-purpose hard-surface disinfectants/sanitizers/virucides (floor,
bathroom, food-contact-surface cleaners: Rest Stop, AF79, Pine Quat, Fight-Bac, GE Fight Bac,
Glybet, Cide-bet, Sure Bet, Triforce, Quat-Stat, pH7Q, Sanibet, VersiFect, Daily Disinfectant
Dual). The new 70 are all M000xxx hand-hygiene/skin-care formulas (Winning Hands hand soaps,
Clario Ultra Blue, ethanol hand sanitizers). No formula_code, product name, or EPA registration
number matched between the two sets. Consequently:

- **superseded-by-new-report: 0** — nothing in the new 70 supersedes any legacy claim.
- **unique-still-valuable: 22**
- **drop: 2** (exact-duplicate files within the legacy set itself — see below)

## SQL footgun check (per ticket)

Grepped all 24 files (case-insensitive) for `SELECT|INSERT|UPDATE|CREATE TABLE|document_chunks|
snowflake`. **No matches.** None of the 24 legacy sheets contain the old Snowflake
`document_chunks` SQL the ticket warned about; nothing was executed or adapted.

## Drop (exact duplicates)

| File | Duplicate of | Basis |
|---|---|---|
| `070-efficacy-sheet.md` | `Efficacy_Data_070_Rest_Stop.md` | Byte-identical body/frontmatter (only `source_pdf` differs) |
| `af79-efficacy-sheet.md` | `Efficacy_Data_079_AF79.md` | Byte-identical body/frontmatter (only `source_pdf` differs) |

Recommendation: keep the `Efficacy_Data_*`-named copy of each pair (matches the naming
convention used by 20 of the 24 files) and drop the terser-named twin.

## Unique-still-valuable (22 files)

| Formula | Product | EPA reg # | Note |
|---|---|---|---|
| 070 | Rest Stop | 47371-97-4170 | canonical copy (see drop above) |
| 079 | AF79 | 6836-193-4170 | canonical copy (see drop above) |
| 087 | Betco Cide-bet II | 706-65-4170 | |
| 1086 | Betco Glybet III | 67603-4-4170 | |
| 237 | Symplicity Sanibet Multi-Range | 6836-266-4170 | distinct SKU from Sanibet RTU (342) |
| 304 | Betco Pine Quat | 47371-192-4170 | |
| 311 | Betco Disinfectant Fight-Bac™ RTU | 1839-83-4170 | US; paired with Canadian sheet below |
| 311 | Fight-Bac™ RTU Disinfectant Cleaner | — | Canadian counterpart, same formula_code |
| 314 | Sure Bet II | 6836-86-4170 | |
| 315 | AF315 | 6836-165-4170 | distinct SKU from AF79 (079/331) |
| 316 | pH7Q | 47371-131-4170 | distinct SKU from pH7Q Dual (355) |
| 331 | AF79 Concentrate | 6836-73-4170 | distinct SKU from AF79 (079) |
| 333 | Triforce | 6836-349-4170 | |
| 341 | Quat-Stat 5 | 6836-361-4170 | |
| 342 | Sanibet RTU | 6836-290-4170 | distinct SKU from Sanibet Multi-Range (237) |
| 355 | pH7Q Dual | 10324-141-4170 | US; paired with Canadian sheet below |
| 355 | Daily Disinfectant Dual | — (Canadian DIN# 02451263) | Canadian counterpart — sheet's own text confirms this is the Canadian name for the same formula |
| 3820 | VersiFect™ | 1839-224-4170 | |
| 390 | GE Fight Bac™ RTU | 34810-35-4170 | US; paired with Canadian sheet below |
| 390 | GE Fight Bac™ RTU - Canadian | — | Canadian counterpart, same formula_code |
| 392 | GE Fight-Bac™ Wipes | 34810-36-4170 | US; paired with Canadian sheet below |
| 392 | GE Fight-Bac™ Wipes (Canada) | — | Canadian counterpart, same formula_code |

## Cross-references worth knowing about (not supersession, just naming overlap)

Several legacy sheets share a **brand name** but are **registered as distinct products** (different
EPA reg numbers / formula codes) — these are kept as separate SKUs, not merged or deduplicated:

- AF79 (079) vs. AF79 Concentrate (331)
- pH7Q (316) vs. pH7Q Dual (355)
- Symplicity Sanibet Multi-Range (237) vs. Sanibet RTU (342)

And four formula codes each have a clean US/Canada regional pair (same formula_code, no EPA reg
printed on the Canadian sheet, slightly different organism list) — both kept per the org's
US+Canada label/regulatory scope: **311, 390, 392, 355**.

## What this means for future ingestion

Because there's no supersession relationship, a future ingestion pass can treat the legacy 24
(minus the 2 duplicates) as an independent, additive corpus alongside the new 70 — no merge
logic or "prefer the new version" resolution is needed between the two sets. Reconciliation
*within* the legacy set (the 2 duplicate drops, and being aware of the brand-name-overlap and
US/Canada pairs above) is the only cleanup this batch identified.
