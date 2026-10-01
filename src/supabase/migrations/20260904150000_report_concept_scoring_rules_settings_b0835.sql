-- B0-835 — the agent-evaluation skill's concept scoring rules, as settings rows.
--
-- Reverses the scoring part of B0-813 (Tom Bird, 2026-09-04). Bex run reports now apply the same
-- four deterministic concept rules the reference skill's concept_rules.py SCORING_DEFAULTS applies,
-- in the same order (methodology §2b Rule 4 step 7): Completeness is capped at expected-concept
-- coverage, the four sub-scores are weighted, satisfying every mandatory concept floors the score
-- at 70 (withheld on a material factual issue), and missing any mandatory concept caps the score
-- at 59 (grade F, Result Fail; the ceiling runs last and outranks the floor). Full expected
-- coverage with no material issue is an automatic Pass. The uncapped arithmetic survives on the
-- case as the Pre-Gate Content Score (a diagnostic, never averaged).
--
-- Each row mirrors one SCORING_DEFAULTS key so a Bex report can state exactly what was in force,
-- the way the skill's eval.json `scoring_config` does. Read once per report by loadScoringRules()
-- (src/lib/tests/report/scoring-config.ts) and persisted on report_state.scoringRules, so a change
-- here affects new reports only; reports already generated keep the rules they were graded under.
-- Booleans are the text 'true'/'false' (getBooleanSetting); numbers are 0-100 and clamped.
-- `on conflict (key) do nothing` keeps re-runs from clobbering an operator's tuned value.
insert into public.settings (key, value, value_type, description, allowed_values) values
  (
    'REPORT_MINIMAL_GATE_ENABLED',
    'true',
    'boolean',
    'Run-report mandatory gate (agent-evaluation methodology 2b Rule 1, B0-835). When true, a case missing ANY mandatory (must-have) concept is rated Fail whatever its weighted score, and the mandatory ceiling (REPORT_MINIMAL_CEILING_*) expresses that verdict in the score. When false the gate AND the ceiling are both off and the report says so. Reference default true. Read once per report and persisted on report_state.scoringRules.',
    null
  ),
  (
    'REPORT_MINIMAL_FLOOR_ENABLED',
    'true',
    'boolean',
    'Run-report mandatory floor (methodology 2b Rule 1b, B0-835). When true, a case that satisfies EVERY mandatory concept scores at least REPORT_MINIMAL_FLOOR_SCORE, because the must-have content was delivered. Only ever raises a score; never applies to a case missing a mandatory concept. Reference default true. Read once per report and persisted on report_state.scoringRules.',
    null
  ),
  (
    'REPORT_MINIMAL_FLOOR_SCORE',
    '70',
    'number',
    'The score full mandatory-concept coverage is worth in a run report (0-100, methodology 2b Rule 1b, B0-835): a C. Independent of REPORT_PASS_MARK, which says where Pass begins — do not change one to move the other. Reference default 70. Read once per report and persisted on report_state.scoringRules.',
    null
  ),
  (
    'REPORT_MINIMAL_FLOOR_RESPECT_MATERIAL_ISSUE',
    'true',
    'boolean',
    'When true (reference default), the run-report mandatory floor is withheld on a case the grader flagged with a material factual issue (wrong dilution, contact time, ppm, CAS, EPA reg. no., fabrication), so full mandatory coverage cannot protect a wrong regulated value from scoring below a C (methodology 2b Rule 1b, B0-835). Read once per report and persisted on report_state.scoringRules.',
    null
  ),
  (
    'REPORT_MINIMAL_CEILING_ENABLED',
    'true',
    'boolean',
    'Run-report mandatory ceiling (methodology 2b Rule 1, B0-835). When true, a case missing ANY mandatory concept has its overall score capped at REPORT_MINIMAL_CEILING_SCORE, so its grade is F and its Result Fail by arithmetic — grade, number and Result always agree and no row can read "B / Fail". The uncapped arithmetic is kept on the case as the Pre-Gate Content Score. Has no effect while REPORT_MINIMAL_GATE_ENABLED is false. Reference default true. Read once per report and persisted on report_state.scoringRules.',
    null
  ),
  (
    'REPORT_MINIMAL_CEILING_SCORE',
    '59',
    'number',
    'The cap a run-report case scores at when it misses a mandatory concept (0-100, methodology 2b Rule 1, B0-835). 59 = the top of the F band, so the case fails under either the 60 or the 70 pass mark. Reference default 59. Read once per report and persisted on report_state.scoringRules.',
    null
  ),
  (
    'REPORT_EXPECTED_COVERAGE_ENABLED',
    'true',
    'boolean',
    'Run-report expected-coverage cap on Completeness (methodology 2b Rule 3, B0-835). When true, Completeness = min(grader''s judged Completeness, round(100 x expected concepts satisfied / required)), so missing expected content lowers the grade proportionally; where the cap binds the case shows both numbers ("40 (judged 66)"). When false Completeness is purely the judged value and the report says so. A pass with no judged Completeness (graded 2026-09-03 to 2026-09-04) uses the coverage share either way. Reference default true. Read once per report and persisted on report_state.scoringRules.',
    null
  )
on conflict (key) do nothing;

-- REPORT_PASS_MARK's description was written for pure-math scoring and said nothing else moves a
-- Result. The concept rules above now do — through the score, never behind it.
update public.settings
set description = 'Run-report pass mark (0-100). A case whose overall score is at or above this mark reads Pass; below it reads Fail. The overall is the weighted sum (Accuracy 40 / Completeness 30 / Relevance 20 / Clarity 10) after the concept rules in REPORT_MINIMAL_* / REPORT_EXPECTED_COVERAGE_ENABLED have been applied to it (B0-835): a missing mandatory concept caps it at the mandatory ceiling (Fail), full mandatory coverage floors it at the mandatory floor. 60 = A/B/C/D pass, F fails; 70 would fail D as well. Independent of REPORT_MINIMAL_FLOOR_SCORE (what full mandatory coverage is worth). Read once per report by loadPassMark (src/lib/tests/report/scoring-config.ts) and persisted on report_state.passMark, so changing it affects new reports only.'
where key = 'REPORT_PASS_MARK';
