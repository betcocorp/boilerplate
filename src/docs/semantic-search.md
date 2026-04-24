# Semantic Search Action Plan

## Goal
Improve answer quality by retrieving product-specific evidence first, then expanding with linked SDS evidence, instead of relying only on flat similarity ranking.

## Actionable Steps

1. Add a product resolution step before final context assembly.
   - Resolve the most likely `product_line_key` (top 1-3 candidates) from the user query.
   - If confidence is low, do not force a product lock.

2. Implement hybrid retrieval routing.
   - If a product is confidently identified: run product-anchored retrieval.
   - If product is ambiguous/unknown: run broad corpus retrieval first, then resolve product and expand.
   - If still unclear: ask a narrow clarification question (product name/SKU).

3. Assemble evidence by product line.
   - Pull product profile chunks for the resolved product line.
   - Pull corresponding SDS chunks for the same product line.
   - Merge both sets into one evidence bundle for synthesis.

4. Improve curation beyond similarity-only ranking.
   - Keep top semantic matches, but enforce coverage/diversity across sections.
   - Prefer at least one usage/procedure chunk and one safety/SDS chunk when available.
   - Avoid over-selecting near-duplicate generic chunks.

5. Add safety and quality guardrails.
   - If usage/safety evidence is insufficient, respond with "insufficient evidence" and request missing details.
   - Do not generate definitive procedural claims without supporting snippets.

6. Validate with a small eval set.
   - Create 25-50 representative questions (including "How do I use X product?").
   - Track: product-match accuracy, evidence coverage (usage + safety), and grounded answer rate.

## First Implementation Slice

- Implement product resolution + evidence assembly (product + linked SDS by `product_line_key`).
- Keep existing retrieval as fallback for ambiguous discovery queries.
- Add minimal coverage rule in curation so final context includes both usage and safety when available.
