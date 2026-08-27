-- B0-719 / B0-720 — multi-pass report grading, configured in `public.settings` (never an env var).
--
-- Both rows are seeded at the values the code already falls back to, so applying this migration
-- changes no behaviour at all: it only makes the two knobs visible and editable in /admin/settings.
--
-- REPORT_GRADING_PASSES ships at 1, NOT 3 (decided by Tom Bird, 2026-08-27). Multi-pass grading is
-- opt-in: every extra pass is another full grading call per case, against the same 260s wall-clock
-- budget a long run already presses against. 1 reproduces the single-pass report exactly.
insert into public.settings (key, value, value_type, description)
values
  (
    'REPORT_GRADING_PASSES',
    '1',
    'number',
    'How many independent LLM grading passes each case gets in a run report (B0-719). 1 = today''s behaviour and the shipped default. Above 1, every case is graded that many times with no pass seeing another''s scores, the sub-scores are consolidated by median, and the report gains a grading-consistency section. Whole numbers only, clamped to 1-9. Cost and wall clock scale linearly with this.'
  ),
  (
    'REPORT_CONSISTENCY_SPREAD_THRESHOLD',
    '10',
    'number',
    'Score range (max - min of a case''s per-pass overall scores) at or above which the case is flagged for human review (B0-720). Only has an effect when REPORT_GRADING_PASSES is above 1.'
  )
on conflict (key) do nothing;
