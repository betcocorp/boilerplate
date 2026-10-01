-- Golden test set format v2: concept / source / citation expectations per test item.
-- Free-text (not arrays) so regulated values — dilution ratios, oz/gal, mL/L, ppm, contact
-- times, EPA reg numbers — are stored exactly as the author typed them, with no splitting
-- or normalization by the app.
alter table public.test_items
  add column if not exists expected_concepts text null,
  add column if not exists minimum_concepts text null,
  add column if not exists expected_sources text null,
  add column if not exists should_cite boolean null;

comment on column public.test_items.expected_concepts is 'Key concepts the ideal answer should contain, verbatim as authored (single string). Null = unset.';
comment on column public.test_items.minimum_concepts is 'Subset of expected_concepts required for a passing answer, verbatim as authored (single string). Null = unset.';
comment on column public.test_items.expected_sources is 'Sources the answer should draw from, comma-separated as authored (e.g. "Ax-It Plus TDS, Selector Guide Section 1"). Null = unset.';
comment on column public.test_items.should_cite is 'Whether the answer is expected to cite sources. Null = no expectation.';
