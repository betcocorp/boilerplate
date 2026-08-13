-- B0-377: per-item priority ranking and gold-standard answer for test set items.
alter table public.test_items
  add column if not exists priority int2 null,
  add column if not exists ideal_response text null;

comment on column public.test_items.priority is 'Optional per-item priority (int2). Null = unset.';
comment on column public.test_items.ideal_response is 'Optional gold-standard/ideal answer text for this prompt.';
