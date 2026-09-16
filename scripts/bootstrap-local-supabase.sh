#!/usr/bin/env bash

npx supabase start -x postgrest
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
-c "create schema if not exists rag; create schema if not exists legacy;
    grant usage on schema rag, legacy to anon, authenticated, service_role;"
npx supabase stop && npx supabase start
pnpm db:restore-local