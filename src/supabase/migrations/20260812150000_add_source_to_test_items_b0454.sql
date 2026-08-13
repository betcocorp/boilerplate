alter table public.test_items
  add column source text null;

comment on column public.test_items.source is
  'Free-text origin of the prompt, e.g. email, bex, contact-us. Not an enum — display/labelling only.';
