/**
 * B0-418 — the run's own measurements, rendered in the trace page header: model tag,
 * retrieval similarity, timing breakdown, token usage and the validator's verdict.
 *
 * Every value is read from the run's `final_output` / `user_input` by
 * `~/lib/observability/run-payload` and degrades to an explicit "n/a": coverage is
 * partial by row (token usage and retrieved chunks were added later, and older runs
 * legitimately have gaps), so a blank or a bare 0 would read as a real measurement.
 */

import { Badge } from '~/components/ui/badge';
import { formatSimilarityValue } from '~/lib/tests/format';

import type { RunPayloadView } from '~/lib/observability/run-payload';
import type {
  ActiveGates,
  GateActivationRecord,
  ValidatorMode,
} from '~/lib/workflows/product-support/product-support-schemas';

const NA = 'n/a';

/**
 * B0-358 — the deterministic guardrails, in the order the workflow evaluates them, with the labels
 * a reviewer would recognise. `validator` is deliberately excluded: it gets its own mode chip above,
 * because "was this answer checked by a model at all" is the question the panel exists to answer.
 */
const GUARDRAIL_LABELS: Array<{ key: keyof ActiveGates; label: string }> = [
  { key: 'earlyDeclineGate', label: 'early decline' },
  { key: 'usageSafetyCoverage', label: 'usage/safety coverage' },
  { key: 'regulatedClaimGuardrail', label: 'regulated-claim grounding' },
  { key: 'recommendationConfidence', label: 'recommendation confidence' },
  { key: 'recommendationEngineVerdict', label: 'recommendation engine verdict' },
  { key: 'crossReferenceSelfReference', label: 'cross-reference self-reference' },
];

/**
 * B0-358 — a guardrail that RAN AND PASSED must look different from one that never ran, and both
 * must look different from one the B0-452 kill switch neutered. Colour carries that distinction;
 * the title attribute carries the exact recorded reason/verdict.
 */
function guardrailBadgeClassName(record: GateActivationRecord): string {
  if (record.state === 'bypassed') {
    return 'border-destructive/45 bg-destructive/10 text-destructive';
  }
  if (record.state === 'ran') {
    return record.verdict && record.verdict !== 'passed' && record.verdict !== 'approved'
      ? 'border-amber-600/45 bg-amber-600/12 text-amber-900'
      : 'border-emerald-600/45 bg-emerald-600/12 text-emerald-900';
  }
  // skipped / not_applicable — a real state, but never rendered as a pass.
  return 'border-slate-300 bg-slate-100 text-slate-600';
}

function guardrailStateLabel(record: GateActivationRecord): string {
  if (record.state === 'ran') {
    return record.verdict ? `ran · ${record.verdict}` : 'ran';
  }
  return record.state === 'not_applicable' ? 'n/a this turn' : record.state;
}

/**
 * B0-358 — the run's verification level. Renders NOTHING for a run written before this ticket
 * (`null`): a placeholder would be a claim, and "unknown" must not read as "validated".
 */
function ValidatorModeBadge({ mode }: { mode: ValidatorMode | null }) {
  if (!mode) {
    return null;
  }
  if (mode === 'llm') {
    return (
      <Badge
        className="border-emerald-600/45 bg-emerald-600/12 text-emerald-900"
        title="validatorMode: llm — the LLM validator pass genuinely ran and judged this answer."
        variant="outline"
      >
        LLM validator ran
      </Badge>
    );
  }
  return (
    <Badge
      className="border-amber-600/45 bg-amber-600/12 text-amber-900"
      title={
        mode === 'bypassed'
          ? 'validatorMode: bypassed — no LLM validator pass ran on this turn (REC-4: useValidator defaults to false on the live Bex path, or the B0-546 high-similarity skip applied). The confidence number is a heuristic, not a judgment. The deterministic guardrails below still ran.'
          : 'validatorMode: not_run — the early-decline gate short-circuited this turn before a validator step existed.'
      }
      variant="outline"
    >
      {mode === 'bypassed' ? 'validator bypassed' : 'validator not run'}
    </Badge>
  );
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function formatSearchMs(value: number | null): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(1)} ms`
    : NA;
}

function Field({
  hint,
  label,
  value,
}: {
  hint?: string | null;
  label: string;
  value: string;
}) {
  const isEmpty = value === NA;
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd
        className={
          isEmpty
            ? 'text-xs text-slate-400'
            : 'font-mono text-xs tabular-nums text-slate-800'
        }
      >
        {value}
      </dd>
      {hint ? <p className="text-[0.65rem] text-slate-500">{hint}</p> : null}
    </div>
  );
}

export function RunPayloadSummary({ payload }: { payload: RunPayloadView }) {
  const { activeGates, modelTag, similarity, timing, usage, validation, validatorMode } =
    payload;

  return (
    <div className="mt-6 space-y-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <Field label="Model" value={modelTag ?? NA} />
        <Field
          hint={similarity ? 'across all retrieved sources' : null}
          label="Similarity min / avg / max"
          value={
            similarity
              ? `${formatSimilarityValue(similarity.min)} / ${formatSimilarityValue(
                  similarity.avg,
                )} / ${formatSimilarityValue(similarity.max)}`
              : NA
          }
        />
        <Field
          label="Tool rounds"
          value={timing ? formatCount(timing.toolRounds) : NA}
        />
        <Field label="Cache source" value={timing?.cacheSource ?? NA} />
        <Field
          label="RAG search"
          value={timing ? formatSearchMs(timing.searchMs) : NA}
        />
        <Field
          hint={
            usage
              ? `${formatCount(usage.promptTokens)} prompt · ${formatCount(
                  usage.completionTokens,
                )} completion · ${
                  typeof usage.cachedPromptTokens === 'number'
                    ? `${formatCount(usage.cachedPromptTokens)} cached`
                    : 'cached n/a'
                }`
              : null
          }
          label="Token usage"
          value={usage ? `${formatCount(usage.totalTokens)} total` : NA}
        />
      </dl>

      <div className="rounded-2xl border border-slate-100 bg-slate-50/70 p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
          Verification
        </p>
        {/* B0-358 — how far this run's verification actually got, at a glance: which validator
            mode, then every deterministic guardrail including the ones that ran and PASSED.
            Both render nothing at all for a run that predates the instrumentation. */}
        {validatorMode || activeGates ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <ValidatorModeBadge mode={validatorMode} />
            {activeGates
              ? GUARDRAIL_LABELS.map(({ key, label }) => {
                  const record = activeGates[key];
                  if (!record) {
                    // Absent key = the run predates this gate. Never invent a state for it.
                    return null;
                  }
                  return (
                    <Badge
                      className={`rounded-full px-2 py-0 text-[0.65rem] ${guardrailBadgeClassName(record)}`}
                      key={key}
                      title={`${String(key)}: ${record.state}${
                        record.verdict ? ` (${record.verdict})` : ''
                      }${record.reason ? ` — ${record.reason}` : ''}`}
                      variant="outline"
                    >
                      {label} · {guardrailStateLabel(record)}
                    </Badge>
                  );
                })
              : null}
          </div>
        ) : null}
        {validation ? (
          <>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge
                className={
                  validation.approved
                    ? 'border-emerald-600/45 bg-emerald-600/12 text-emerald-900'
                    : 'border-destructive/45 bg-destructive/10 text-destructive'
                }
                variant="outline"
              >
                {validation.approved ? 'approved' : 'not approved'}
              </Badge>
              <Badge className="tabular-nums" variant="outline">
                confidence {validation.confidence.toFixed(2)}
              </Badge>
              {validation.requires_human_review ? (
                <Badge
                  className="border-amber-600/45 bg-amber-600/12 text-amber-900"
                  variant="outline"
                >
                  human review required
                </Badge>
              ) : null}
            </div>
            {validation.issues.length > 0 ? (
              <ul className="mt-3 space-y-1">
                {validation.issues.map((issue, index) => (
                  <li
                    className="break-words font-mono text-xs text-slate-700"
                    key={`${index}:${issue}`}
                  >
                    {issue}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-slate-500">No issues reported.</p>
            )}
          </>
        ) : (
          <p className="mt-1.5 text-xs text-slate-400">
            n/a — no validator verdict recorded on this run.
          </p>
        )}
      </div>
    </div>
  );
}
