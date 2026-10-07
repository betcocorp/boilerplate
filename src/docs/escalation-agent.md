# Escalation Agent — Technical Specification

> Status: Draft v0.2
> Owner: Tom Bird / Solutions Architecture
> Scope: bex-2.0 multi-agent system ("Bex")

## What this agent does

When Bex can't answer a user's question — because the document corpus doesn't have the information, or what it has isn't good enough — the Escalation Agent takes over. It packages up everything we know about the failed question, opens a ticket in HubSpot for a human to answer, tracks that ticket through review and approval, and when the answer is ready it feeds the new knowledge back into Bex's corpus and notifies the original user.

In other words: every "I don't know" becomes a ticket, every ticket becomes a new piece of documentation, and the person who asked the question gets a real answer instead of a dead end.

## The flow

1. **User asks a question Bex can't answer.** The orchestrator runs the question through the right specialist agent (product, dilution, floor, bathroom, etc.) and either finds no good evidence or the answer comes back below our confidence threshold.
2. **Orchestrator hands off to the Escalation Agent** with a payload containing the user's contact info, the original prompt, which specialist agent tried to answer, the audit trail of what context was retrieved, and the reason the prompt was rejected.
3. **Escalation Agent sends that payload to HubSpot** as a new ticket in a dedicated `Bex Escalations` pipeline.
4. **User gets a short acknowledgment back in Bex** — something like "I don't have a confident answer for that, I've opened ticket #1234 and someone from our team will follow up." The ticket reference is stored so the user can check status later.
5. **Customer service rep sees the new ticket** in HubSpot, reviews the prompt and the audit trail Bex captured, fills in the answer (either by writing it directly or by attaching a document), and submits the ticket for closure.
6. **Business analyst (or designated approver) reviews the rep's answer** and either approves or sends it back for revision. Approval is the gate — nothing enters the corpus until an approver signs off.
7. **Approval fires a webhook back into Bex.** That webhook does two things at once:
    1. Sends the approved answer / document into our automated ingestion pipeline, which embeds it and stores it in the document corpus so future questions can use it.
    2. Triggers an outreach to the original user (email or in-Bex notification) with the answer, plus a link back to the ticket.
8. **Loop closes.** The next time someone asks a similar question, Bex answers it directly because the corpus now has the information.

## Technical needs, step by step

### Step 1 — Detect that Bex can't answer

**Where it lives:** inside the orchestrator (`~/lib/orchestrator/run-orchestration.ts`), at the point where the specialist agent has already returned its result.

**What we need to build:**
- A small check that looks at the specialist's response and decides whether to escalate. Triggers include: confidence score below threshold, no supporting documents found, repeated failed clarification attempts, or the user explicitly asking for help.
- An "escalation payload" type that captures everything the Escalation Agent will need (user info, prompt, what was tried, what was retrieved, why it failed).

**No new endpoint needed for this step** — it's an in-process check the orchestrator runs every time.

### Step 2 — Hand off to the Escalation Agent

**Where it lives:** new agent at `~/lib/agents/escalation/`.

**What we need to build:**
- The agent itself, structured like our existing specialist agents (entry function, schemas, helpers).
- A function the orchestrator calls directly (no HTTP hop needed since it's running in the same Next.js process).
- A Supabase table called `escalations` that stores the payload along with the resulting HubSpot ticket ID, status, the user who asked, and timestamps for each lifecycle event.

### Step 3 — Create the HubSpot ticket

**Where it lives:** `~/lib/integrations/hubspot/`.

**What we need to build:**
- A thin HubSpot API client (auth, retry, error handling).
- A dedicated HubSpot pipeline called `Bex Escalations` with stages like `New → In Review → Awaiting Approval → Approved → Closed`.
- A handful of custom ticket properties so we can round-trip data: `bex_escalation_id`, `bex_prompt`, `bex_routed_agent`, `bex_audit_trail`, `bex_resolution_type` (document vs written answer), `bex_resolution_payload`.
- A Private App token in HubSpot with ticket + contact scopes, stored as an env var on Vercel.

**Endpoint:** none on our side for this step — we are calling HubSpot's API outbound.

### Step 4 — Acknowledge the user in Bex

**Where it lives:** orchestrator response shape (`~/lib/orchestrator/orchestrator-schemas.ts`).

**What we need to build:**
- An optional `escalation` block on the orchestrator response that carries the ticket ID, ticket URL, and a short user-facing message.
- A small UI treatment in the Bex chat (`~/components/bex/`) that renders the escalation acknowledgment differently from a normal answer — clear visual cue that this is a "we're working on it" message with a ticket reference.

### Step 5 — CS rep fills in the answer

**Where it lives:** entirely inside HubSpot — no Bex UI work here in v1.

**What we need to build / set up:**
- HubSpot ticket views and saved filters for the CS team (one for "new tickets needing answers", one for "my tickets in progress").
- A short SOP doc for CS reps: how to read the audit trail, where to put the answer, whether to attach a document or write inline, how to submit for approval.
- Optional v2: a small in-Bex admin view at `/admin/escalations` that mirrors the HubSpot data for people who don't have HubSpot seats.

### Step 6 — Business analyst approves

**Where it lives:** HubSpot pipeline configuration + a HubSpot workflow.

**What we need to build / set up:**
- The `Awaiting Approval` stage in the pipeline.
- A HubSpot workflow that requires a user in the "Bex Escalation Approvers" team to move a ticket from `Awaiting Approval` to `Approved`.
- A required custom property check: a ticket cannot be moved to `Approved` unless `bex_resolution_payload` is filled in.

### Step 7a — Webhook fires back into Bex and ingests the new knowledge

**Where it lives:** new API route at `POST /api/v1/escalations/hubspot-webhook`.

**What we need to build:**
- The webhook endpoint, verifying HubSpot's signature so we know the request is legitimate.
- Logic to read the resolution payload off the ticket, find the matching `escalations` row by `bex_escalation_id`, and hand the content to the ingestion pipeline.
- Reuse the existing RAG ingestion (`~/lib/rag/pipeline.ts`) — the escalation agent does not need its own ingestion path. It just wraps the content with the right metadata (source = escalation, product line key, owning agent) and calls into the existing pipeline.
- Mark the escalation row as `ingested` with a timestamp.

### Step 7b — Notify the original user

**Where it lives:** same webhook handler from step 7a, with a notification helper at `~/lib/agents/escalation/notifier.ts`.

**What we need to build:**
- An email template (transactional, sent via whatever we already use — likely Supabase Auth's SMTP or a service like Resend) that includes the original question, the approved answer, and a deep link back to Bex.
- Optional in-app notification if the user is active in Bex.
- A flag on the escalation row to prevent double-notify in case the webhook fires twice.

### Step 8 — Verify the loop closed

**Where it lives:** lightweight reporting, not a user-facing step.

**What we need to build:**
- A simple dashboard view (Power BI or an in-app admin page) showing: tickets opened per week, average time to approval, how many corpus entries came from escalations, and how many repeat questions on the same topic dropped after ingestion.
- Optional automated re-test: after ingestion, re-run the original prompt through Bex in a background job and log whether it now answers confidently. This is a nice-to-have for quality assurance, not required for the loop to work.

## Roles and who does what

| Role | Where they work | What they do |
|---|---|---|
| End user | Bex chat | Asks the question, gets an acknowledgment, eventually gets the answer |
| Orchestrator | bex-2.0 | Detects the failure, calls the Escalation Agent |
| Escalation Agent | bex-2.0 | Packages the payload, creates the HubSpot ticket, stores the audit trail |
| Customer service rep | HubSpot | Reviews the ticket, writes/attaches the answer, submits for approval |
| Business analyst (approver) | HubSpot | Reviews the rep's answer, approves or rejects |
| Webhook handler | bex-2.0 | Receives the approval, ingests into the corpus, notifies the user |
| RAG ingestion pipeline | bex-2.0 (existing) | Embeds and stores the new content for future answers |

## What we need from each system

**Bex (Next.js / Node / Supabase)**
- New agent module at `~/lib/agents/escalation/`
- New `escalations` Supabase table
- New API route for the HubSpot webhook
- Small orchestrator change to detect failures and call the agent
- Small Bex chat UI change to render the escalation acknowledgment

**HubSpot**
- New `Bex Escalations` pipeline with the stages above
- Custom ticket properties to carry Bex's data
- Workflow rule requiring an approver to close
- Private App token with ticket + contact scopes
- Outbound webhook configured to hit our endpoint on approval

**RAG / Corpus (existing)**
- No changes needed — we reuse the existing ingestion pipeline. The escalation agent is just a new caller of it.

## Rollout phases

**Phase 1 — Plumbing**
Build the agent, the table, the HubSpot pipeline, and the ticket creation path. Run in shadow mode: tickets get created in a sandbox HubSpot pipeline but users don't see anything different yet.

**Phase 2 — User-facing acknowledgment**
Wire up the orchestrator response and the Bex chat UI so users actually see the "ticket opened" message. Switch to the production HubSpot pipeline.

**Phase 3 — Approval loop and ingestion**
Stand up the webhook, hook up the approval workflow in HubSpot, wire ingestion and user notification.

**Phase 4 — Reporting and admin UI**
Build the dashboard, add the optional in-Bex admin view for non-HubSpot users.

## Open questions

1. Who owns approval — a specific named team, or anyone with a "manager" role in HubSpot? This affects the workflow rule we set up.
2. Should users who hit the same gap before it's resolved be attached to the same ticket and notified together, or do they each get their own ticket? Attaching saves CS time; separate tickets give cleaner per-user history.
3. For "won't fix" outcomes (the answer is "we deliberately don't document this"), do we still write something into the corpus so Bex can give an honest direct answer next time instead of escalating again?
4. Do we need an SLA on how long a ticket can sit before it gets nudged, and if so does HubSpot's workflow engine handle that or do we build a small reminder job on our side?
