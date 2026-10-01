-- B0-812 — REPORT_PASS_MARK: the one number the run report's Result is derived from.
--
-- Pure-math scoring (B0-813, Tom Bird 2026-09-03): a case's Result is Pass when its weighted
-- overall is at or above this mark and Fail below it, and nothing else moves a Result — no concept
-- gate, no floor, no ceiling, no automatic Pass. This replaces the previous three-band model
-- (Pass ≥ 80 / Partial Pass 60–79 / Fail < 60), which was hardcoded in
-- src/lib/tests/report/metrics.ts and had no settings row.
--
-- Seeded to 60 so that A/B/C/D pass and only an F fails — the same line the reference
-- agent-evaluation methodology currently uses (methodology §2). The stricter 70 line is not a
-- second setting: every report lists the cases that pass only under the current mark, so the cost
-- of tightening is visible before anyone tightens. Resolved once per report by loadPassMark()
-- (src/lib/tests/report/scoring-config.ts) and persisted on report_state.passMark, so a change
-- here affects new reports only; reports already generated keep the mark they were graded at.
--
-- allowed_values is null: any 0–100 number is valid and the getter clamps to that range.
insert into public.settings (key, value, value_type, description, allowed_values)
values
  (
    'REPORT_PASS_MARK',
    '60',
    'number',
    'Run-report pass mark (0-100). A case whose weighted overall (Accuracy 40 / Completeness 30 / Relevance 20 / Clarity 10) is at or above this mark reads Pass; below it reads Fail. Nothing else changes a Result (pure-math scoring, B0-813). 60 = A/B/C/D pass, F fails; 70 would fail D as well. Read once per report by loadPassMark (src/lib/tests/report/scoring-config.ts) and persisted on report_state.passMark, so changing it affects new reports only.',
    null
  )
on conflict (key) do nothing;
