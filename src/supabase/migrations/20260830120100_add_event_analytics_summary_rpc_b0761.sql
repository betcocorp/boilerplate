-- B0-761 — one round trip for the whole /admin/analytics payload.
--
-- This has to be a database function rather than in-process aggregation: this project's
-- PostgREST runs with `db-max-rows = 1000` and aggregate functions disabled, so the
-- summary cannot be produced by fetching `event_logging` rows through supabase-js and
-- folding them in Node (as `~/lib/api/analytics-repository.ts` does for `api_request_log`,
-- whose volume is three orders of magnitude smaller).
--
-- Semantics mirror c360's EventLoggingController.getSummary so the two dashboards report
-- the same numbers: a rolling `days` window from now(), an optional permission-group
-- filter, per-day and per-hour buckets, top-10 events/pages with distinct-actor counts,
-- and top-10 actors by successful login and by page view.
--
-- `user_key` prefers the denormalized `user_id` column and falls back to meta, so rows
-- written before actor denormalization still attribute correctly.

create or replace function public.event_analytics_summary(
  p_days integer default 30,
  p_groups text[] default null
)
returns jsonb
language sql
stable
as $$
with params as (
  select
    greatest(1, least(coalesce(p_days, 30), 365)) as days,
    coalesce(p_groups, '{}'::text[]) as groups
),
scoped as (
  select
    e.id,
    e.event,
    e.created_at,
    coalesce(
      nullif(btrim(e.user_id), ''),
      nullif(btrim(e.meta ->> 'userId'), ''),
      nullif(btrim(e.meta ->> 'email'), '')
    ) as user_key,
    coalesce(
      nullif(btrim(e.meta ->> 'name'), ''),
      nullif(btrim(e.meta ->> 'email'), ''),
      nullif(btrim(e.meta ->> 'userId'), ''),
      nullif(btrim(e.user_id), ''),
      'Unknown'
    ) as display_label
  from public.event_logging e
  cross join params p
  where e.created_at >= now() - make_interval(days => p.days)
    and (
      cardinality(p.groups) = 0
      or e.meta -> 'permission_groups' ?| p.groups
    )
),
totals as (
  select count(*)::bigint as total, count(distinct event)::bigint as distinct_events
  from scoped
),
login_base as (
  select date_trunc('day', created_at) as day, user_key, display_label
  from scoped
  where event = 'analytics.user.login.success' and user_key is not null
),
login_top as (
  select user_key from login_base
  group by user_key
  order by count(*) desc, user_key
  limit 10
),
page_view_base as (
  select date_trunc('day', created_at) as day, user_key, display_label
  from scoped
  where event like 'analytics.page.view%' and user_key is not null
),
page_view_top as (
  select user_key from page_view_base
  group by user_key
  order by count(*) desc, user_key
  limit 10
),
top_events as (
  select event, count(*)::bigint as cnt, count(distinct user_key)::bigint as user_cnt
  from scoped
  group by event
  order by count(*) desc, event
  limit 10
),
top_pages as (
  select event, count(*)::bigint as cnt, count(distinct user_key)::bigint as user_cnt
  from scoped
  where event like 'analytics.page.view%'
  group by event
  order by count(*) desc, event
  limit 10
),
recent as (
  select id, event, created_at from scoped order by created_at desc limit 25
)
select jsonb_build_object(
  'days', (select days from params),
  'selectedGroups', to_jsonb(coalesce(p_groups, '{}'::text[])),
  'availableGroups', coalesce(
    (select jsonb_agg(pg.selector order by pg.selector)
     from public.permission_group pg
     where pg.deleted_at is null),
    '[]'::jsonb
  ),
  'totalInRange', (select total from totals),
  'uniqueEventNames', (select distinct_events from totals),
  'byDay', coalesce((
    select jsonb_agg(jsonb_build_object('date', d.date, 'count', d.cnt) order by d.date)
    from (
      select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as date, count(*)::bigint as cnt
      from scoped group by 1
    ) d
  ), '[]'::jsonb),
  'interactionsByHour', coalesce((
    select jsonb_agg(jsonb_build_object('hour', h.hour, 'count', h.cnt) order by h.hour)
    from (
      select extract(hour from created_at)::int as hour, count(*)::bigint as cnt
      from scoped group by 1
    ) h
  ), '[]'::jsonb),
  'topEvents', coalesce((
    select jsonb_agg(jsonb_build_object('event', event, 'count', cnt, 'userCount', user_cnt)
                     order by cnt desc, event)
    from top_events
  ), '[]'::jsonb),
  'topPages', coalesce((
    select jsonb_agg(jsonb_build_object('event', event, 'count', cnt, 'userCount', user_cnt)
                     order by cnt desc, event)
    from top_pages
  ), '[]'::jsonb),
  'recent', coalesce((
    select jsonb_agg(jsonb_build_object('id', id, 'event', event, 'created_at', created_at)
                     order by created_at desc)
    from recent
  ), '[]'::jsonb),
  'loginByDay', coalesce((
    select jsonb_agg(jsonb_build_object('date', l.date, 'success', l.success, 'failure', l.failure)
                     order by l.date)
    from (
      select
        to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as date,
        count(*) filter (where event = 'analytics.user.login.success')::bigint as success,
        count(*) filter (where event = 'analytics.user.login.failure')::bigint as failure
      from scoped
      where event in ('analytics.user.login.success', 'analytics.user.login.failure')
      group by 1
    ) l
  ), '[]'::jsonb),
  'loginTopUsersByDay', coalesce((
    select jsonb_agg(jsonb_build_object('date', r.date, 'userKey', r.user_key,
                                        'label', r.label, 'count', r.cnt)
                     order by r.date, r.user_key)
    from (
      select to_char(b.day, 'YYYY-MM-DD') as date, b.user_key,
             min(b.display_label) as label, count(*)::bigint as cnt
      from login_base b
      join login_top t on t.user_key = b.user_key
      group by b.day, b.user_key
    ) r
  ), '[]'::jsonb),
  'pageViewsByUserDay', coalesce((
    select jsonb_agg(jsonb_build_object('date', r.date, 'userKey', r.user_key,
                                        'label', r.label, 'count', r.cnt)
                     order by r.date, r.user_key)
    from (
      select to_char(b.day, 'YYYY-MM-DD') as date, b.user_key,
             min(b.display_label) as label, count(*)::bigint as cnt
      from page_view_base b
      join page_view_top t on t.user_key = b.user_key
      group by b.day, b.user_key
    ) r
  ), '[]'::jsonb)
);
$$;

comment on function public.event_analytics_summary(integer, text[]) is
  'B0-761: full /admin/analytics payload for a rolling p_days window, optionally scoped to permission groups. Port of c360 GET /events/summary.';

revoke all on function public.event_analytics_summary(integer, text[]) from public;
grant execute on function public.event_analytics_summary(integer, text[]) to service_role;
