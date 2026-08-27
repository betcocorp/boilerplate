---
name: remediate
description: >
  Audit a Bex 2.0 eval-harness test run that graded below a B, diagnose the
  root causes behind its lowest-scoring items, and turn that diagnosis into a
  published Confluence remediation plan plus groomed Jira epic/stories — all
  grounded in the live Supabase eval data and the actual bex2.0 codebase, not
  guessed. Use whenever the user gives a test id, an /admin/tests URL, or an
  /admin/tests/.../runs/... URL and asks to remediate, audit, fix, or
  investigate why that test run scored poorly — including "remediate this
  test", "audit this run", "why did this test fail", "fix the issues in this
  run", or pasting a Bex admin test/run link with no further explanation.
  Does NOT write or modify application code — it stops at Jira tickets ready
  for complete-tickets/lets-work to implement.
allowed-tools: Bash, Read, Write, Grep, Glob, WebFetch, mcp__Supabase__list_tables, mcp__Supabase__execute_sql, mcp__Atlassian__atlassianUserInfo, mcp__Atlassian__getAccessibleAtlassianResources, mcp__Atlassian__getVisibleJiraProjects, mcp__Atlassian__getJiraProjectIssueTypesMetadata, mcp__Atlassian__getJiraIssueTypeMetaWithFields, mcp__Atlassian__createJiraIssue, mcp__Atlassian__getJiraIssue, mcp__Atlassian__editJiraIssue, mcp__Atlassian__searchJiraIssuesUsingJql, mcp__Atlassian__addCommentToJiraIssue, mcp__Atlassian__getIssueLinkTypes, mcp__Atlassian__createIssueLink, mcp__Atlassian__lookupJiraAccountId, mcp__Atlassian__getConfluencePage, mcp__Atlassian__createConfluencePage, mcp__Atlassian__searchConfluenceUsingCql, mcp__claude-in-chrome__navigate, mcp__claude-in-chrome__get_page_text
---

# Remediate

Turn a below-B Bex eval run into a code-grounded, published remediation plan
and a groomed set of Jira tickets ready for someone else (`complete-tickets`
or `lets-work`) to implement. This skill never touches the codebase.

## Hard boundary: plan and ticket, never implement

Read the repo and Supabase. Write to Confluence and Jira. Never edit
application code, never branch, never commit. If the user's real intent
turns out to be "and then fix it", finish the grooming and hand off the
epic key — that's a different skill's job.

## Definition of done

1. The target run is identified and its grade confirmed below B (or the run
   reports clean and the skill stops there — that's a valid, complete run).
2. Every item scoring ≤75 (real UI formula, `unableToEvaluate` items
   excluded entirely) has been considered.
3. Items are deduped into finding-groups by LLM judgment of shared root
   cause (the "80% similar" test), with the grouping rationale stated
   explicitly per group — never a silent merge.
4. Each finding-group has trace-enriched evidence (Supabase first, Chrome
   fallback), a net-weight score, and a remediation recommendation that is
   either in-scope (ticketable) or explicitly flagged as an SME-dependent
   follow-up (never ticketed).
5. A Confluence subpage is published under the remediation parent page.
6. One epic + up to 5 stories per in-scope finding-group exist in Jira,
   assigned, prioritized, labeled, and groomed with real file paths.
7. All writes are re-fetched and confirmed to have stuck.
8. A duplicate check ran before any Jira/Confluence write.

A plan that reads well but cites invented file paths or a wrong score has
failed, even if the page and tickets look tidy.

## Autonomy contract

Run end-to-end with no pauses except genuine hard blockers: no repo access,
no Supabase/Jira/Confluence access, or the input can't be resolved to a run
at all. Everything else — grouping calls, net-weight ranking, story
boundaries, priority — is your judgment; state each one explicitly in the
plan and the final report so the user can override after the fact.

---

## Step 0 — Resolve the input to one run

Accepts, in order of specificity:
- A full run URL: `/admin/tests/{testId}/runs/{runId}` (with or without
  `/report`) → use that exact run.
- A bare test URL: `/admin/tests/{testId}` → resolve to that test's most
  recent **completed** run.
- A bare test id (uuid) or test name → look up `tests.id` by id or
  case-insensitive name match against `tests.name`, then resolve to the
  most recent completed run as above.

Resolve "most recent completed run" via:

```sql
select id, test_id, status, completed_at, report_state->'overall' as overall
from test_results
where test_id = $1 and status = 'completed'
order by completed_at desc nulls last
limit 1;
```

If nothing resolves, stop and say so — don't guess a test id from a partial
name match without confirming it's the only candidate.

## Step 1 — Check the grade gate

Read `report_state.overall.grade` (letter) for the resolved run.

- `A` or `B` → report the grade and stop. This is a complete, successful
  run of the skill, not a failure — say so plainly, don't apologize.
- Missing/null `report_state` or `overall.grade` → the run hasn't had a
  report generated yet (`report_state.status` will show why — likely
  `generating` or absent). Stop and tell the user to generate the report
  first (`/admin/tests/{testId}/runs/{runId}/report`).
- Below `B` → proceed.

## Step 2 — Find the real per-item score formula

The below-75 filter must match the number rendered in the admin UI's
per-item score badge (e.g. "72", "85") — not a naive average of
`clarity`/`accuracy`/`relevance`/`completeness`. Grep the repo (start in
`~/lib/tests/`, likely near `runner.ts`, `report`-related files, or wherever
`caseScores`/`report_state` gets written) for the function that computes the
displayed per-item score and letter grade from a `CaseScore`. Confirm by
spot-checking against a known example from the run's own `report_state` if
one is visible.

If the formula genuinely can't be located after a reasonable search, fall
back to a stated, labeled approximation (e.g. a documented weighted
average) and say explicitly in the plan that this is an approximation, not
the exact UI number.

## Step 3 — Pull and filter the below-75 items

```sql
select tri.id as result_item_id, tri.test_item_id, tri.workflow_run_id,
       ti.prompt, ti.row_index,
       tr.report_state->'caseScores'->(tri.test_item_id::text) as case_score
from test_result_items tri
join test_items ti on ti.id = tri.test_item_id
join test_results tr on tr.id = tri.test_result_id
where tri.test_result_id = $run_id;
```

For each row, apply the Step 2 formula to `case_score` to get the real
score. Keep only:
- `case_score->>'unableToEvaluate'` is **not** `true`, AND
- computed score `<= 75`.

Items with `unableToEvaluate: true` are skipped entirely — not scored, not
flagged, not mentioned in the plan. They're a grading gap, not a product
issue.

## Step 4 — Dedup into finding-groups

For every kept item, read `explanation`, `missed`, `incorrect`, and
`improvement` from its `case_score`. Judge — as the LLM, holistically, not
via a literal string/embedding metric — whether two items' write-ups
describe the **same underlying root cause**, even if worded differently
(e.g. "dwell time listed as 5 min, expected 10-15" and "contact time too
short, doesn't match label" are the same root cause; "missing EPA reg
number" and "wrong EPA reg number" are not, even though both mention "EPA
reg number").

Treat this as "would fixing one thing plausibly fix both" — that's the
practical meaning of "80% similar" here, per the user. Merge items meeting
that bar into one finding-group. For every merge, write down which items
merged and the one-sentence reason, in the plan — no silent merges.

Items that don't merge with anything become their own single-item
finding-group.

## Step 5 — Enrich each finding-group with trace evidence

For each item in a finding-group with a non-null `workflow_run_id`, pull
trace context to understand *why* the answer went wrong, not just that it
did. Prefer Supabase directly:

```sql
select ws.step_name, ws.status, ws.output, ws.error
from workflow_steps ws
where ws.workflow_run_id = $workflow_run_id
order by ws.started_at;

select am.role, am.tool_name, am.content, am.plain_text
from agent_messages am
join workflow_runs wr on wr.conversation_id = am.conversation_id
where wr.id = $workflow_run_id
order by am.created_at;
```

Before relying on these queries, grep the repo for the route handlers
behind the two "Download JSON" buttons the user showed
(`/admin/observability/{workflowRunId}` and the per-row download on
`/admin/tests/{testId}/runs/{runId}/report`) to confirm you're reading the
same fields those routes expose, and to check whether `response_payload` on
`test_result_items` already carries retrieval/routing metadata worth
pulling in directly (it does, per B0-495/B0-500 columns — `routing_decision`,
`max_similarity`, `confidence_provenance`, etc. — pull those columns
straight off `test_result_items` first before reconstructing from
`workflow_steps`).

If a needed field genuinely can't be reconstructed from Supabase, fall back
to Chrome: navigate to the live route (`http://localhost:3000/admin/...`)
and read the page/JSON directly. Note in the plan when this fallback was
used, since it depends on a local dev server being up.

Items with a null `workflow_run_id` get no trace enrichment — note that
plainly in the plan rather than silently omitting context.

Also pull the run-level `report_state.synthesis.top3` ("fix these three
things") and `synthesis.strengths`/`weaknesses`/`failurePatterns` — fold
relevant entries into the matching finding-group as corroborating evidence
rather than repeating them as a separate section.

## Step 6 — Score each finding-group and rank priority

Per finding-group, compute:

- **Frequency** = count of deduped items in the group.
- **Severity deficit** = average of `(75 − score)` across the group's
  items (higher = worse).
- **Coverage** = your explicit judgment of how many *other* below-75 items
  in this run — including ones that didn't dedupe into this group by
  wording — are plausibly symptoms of the same root cause if it's
  systemic (e.g. a retrieval gap surfacing as different-looking failures).
  State the reasoning and which items you mean; default to 0 (no
  additional coverage) if you don't see a plausible systemic link — don't
  inflate this to pad weight.
- **Net weight** = `frequency × severity_deficit + coverage`.

Rank finding-groups by net weight within this run and bucket into
High/Medium/Low **relative to this run's own spread** — don't use fixed
cutoffs, since an all-F run would make everything "High" under a fixed
scale. State the buckets' actual weight ranges in the plan so the ranking
is auditable.

## Step 7 — Classify each finding-group: ticketable vs. follow-up-only

For each finding-group, decide whether it belongs in the remediation plan
as ticketable work, or as a documented follow-up only:

**Ticketable (goes into Jira as a story):**
- A model/model-tag change (e.g. `BEX_MODEL_GPT4O` → a newer tag).
- A prompting change (specialist policy text, validator prompt, etc.).
- A routing change (`sme-routing.ts` keyword scoring, agent registry).
- A RAG search/tool change (`~/lib/retrieval/*`, `~/lib/tools/*`,
  `~/lib/rag/search.ts`, retrieval strategy, reranking, chunking).
- Anything else reasonably scoped as 3–5 Jira stories.

**Follow-up only (documented in the plan, never ticketed):**
- Building out missing product/formulation/label data that requires SME
  input to author or verify (this is a data-authoring gap, not a code fix).
- Reviewing individual flagged items for correctness, where the review
  itself requires business/domain knowledge (e.g. "is 10-15 min actually
  the right dwell time for this product" needs a Betco SME, not a prompt
  change).
- Any finding-group whose ticketable fix would genuinely need more than 5
  stories — too big to auto-ticket; note it as a follow-up needing manual
  scoping instead of forcing it into 5 stories that don't actually cover it.

State the classification and the one-line reason for every finding-group,
even the obvious ones.

## Step 8 — Write the Confluence page

Parent page:
`https://betco.atlassian.net/wiki/spaces/Bex/pages/245858305/Automated+report+remediation`
(pageId `245858305`, space `Bex`).

**Before writing**, check for an existing duplicate: search Confluence
children of the parent page (`getConfluencePage` on 245858305, or
`searchConfluenceUsingCql` with `ancestor=245858305`) for a title matching
this exact test name + run timestamp. If found, report the existing page
instead of creating a new one.

Title: `{test name} - {run completed_at in ISO 8601}`.

Content, in order:
1. **Run summary** — test name, run id, grade, overall avg score, item
   counts, link to the run's report page, link to the observability trace
   where used.
2. **Run's own top-3** (`synthesis.top3`) restated briefly, for context.
3. **Finding-groups**, each with: root cause, member items (id + prompt +
   score), dedup rationale, trace evidence summary, frequency / severity
   deficit / coverage / net weight, priority bucket, classification
   (ticketable vs. follow-up), and — if ticketable — the Jira story
   key(s) once created (added after Step 9, or via a follow-up edit).
4. **Follow-ups needing SME input** — the non-ticketable finding-groups,
   clearly separated from the ticketable section so no one mistakes them
   for tracked work.

## Step 9 — Resolve the Jira target

`atlassianUserInfo` for your account id. `getAccessibleAtlassianResources`
for cloudId. `getVisibleJiraProjects` + `getJiraProjectIssueTypesMetadata`
to confirm the project (expect `BO`, matching the existing `BO-###`
convention) and valid issue type names — don't hardcode.

**Duplicate check**: `searchJiraIssuesUsingJql` with something like
`labels = remediation AND text ~ "{test name}" AND text ~ "{run timestamp}"`.
If a matching epic already exists, report it and stop the write step rather
than creating a second one.

## Step 10 — Write to Jira

**One epic** for the whole pass, named:
`{test name} - run {run completed_at date} - remediation plan {today's date}`
(all ISO 8601 dates). Labels `test-runs`, `remediation`. Assigned to the
user. Description links the Confluence page and summarizes the run
(grade, score, finding-group count).

**Per ticketable finding-group**, 1–5 stories (as many as the fix
genuinely needs, capped at 5 per Step 7) under that epic. Each story:
- Labels `test-runs`, `remediation`.
- Assigned to the user.
- Priority from the Step 6 bucket (High/Medium/Low).
- Description follows the standard grounded-ticket shape: the problem
  (quote the finding-group's root cause and evidence — item ids, prompts,
  trace findings), the real code location(s) found via grep (`path:line`,
  not invented), the proposed approach naming what to change, acceptance
  criteria as a checkable list, and out-of-scope notes where relevant.
  Leave status in the project's backlog/default — this skill plans work,
  it doesn't start it.

**Sequencing**: if one story's fix would change what a later story sees
(e.g. a routing fix upstream of a prompting fix), record that as a Jira
issue link (`getIssueLinkTypes` → `createIssueLink`), not just prose.

## Step 11 — Verify and close the loop

Re-fetch every created Jira issue (`getJiraIssue`) and confirm summary,
description, epic link, labels, priority, and assignee actually stuck.
Re-fetch the Confluence page and confirm it rendered. Go back and add the
story keys into the Confluence finding-group sections (edit the page) so
the two artifacts cross-reference each other.

## Step 12 — Report

```
## Run
<test name, run id, grade, score, link to run report, link to observability trace>

## Grade gate
<passed clean / below B and proceeding — state which>

## Findings
<per finding-group: root cause one-liner, item count, net weight, priority,
classification (ticketable/follow-up), evidence highlights>

## Confluence
<page title + link>

## Jira
<epic key + title; each story key + title + priority>

## Follow-ups needing SME input
<finding-groups that were never ticketed, and why>

## Judgment calls
<every dedup merge, every coverage estimate, every priority-bucket cutoff,
anywhere the score formula was approximated instead of grepped, anywhere
Chrome fallback was used instead of Supabase>

## Duplicate check
<what was searched, what was found, if anything>
```

End by naming the epic key and offering the handoff to `complete-tickets`
when the user wants the work actually done.
