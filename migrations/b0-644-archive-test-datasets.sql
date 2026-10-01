-- B0-644: Add archiving capability to test datasets
ALTER TABLE public.tests ADD COLUMN is_archived BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX idx_tests_is_archived ON public.tests(is_archived);
