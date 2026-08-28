/**
 * B0-496 — "is every point in this run that changes the outcome actually measured?", answered on
 * the page instead of by reading `run-product-support-workflow.ts` end to end.
 *
 * Renders only what B0-490..494 persist, via the pure read model in
 * `~/lib/observability/integrity-coverage`. Every number carries the field it came from and the
 * mechanism that produced it, and a node that executed without emitting a record gets an explicit
 * "unmeasured" row — the panel exists to show gaps, not to leave them blank.
 *
 * Values are printed exactly as recorded (no rounding, no unit conversion), and gate `effect`
 * strings are reproduced verbatim: they can quote label/SDS-derived values, which the org's
 * regulated-data rule forbids altering. This is a diagnostic view, not a source of record.
 */

import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { Badge } from '~/components/ui/badge';

import type {
  ConfidenceObservation,
  ConfidenceProvenanceGroup,
  DecisionNodeCoverageRow,
  DecisionNodeStatus,
  RunIntegrityView,
} from '~/lib/observability/integrity-coverage';

const NA = 'n/a';

const STATUS_STYLES: Record<DecisionNodeStatus, string> = {
  measured: 'border-emerald-600/45 bg-emerald-600/12 text-emerald-900',
  unmeasured: 'border-destructive/45 bg-destructive/10 text-destructive',
  unknown: 'border-amber-600/45 bg-amber-600/12 text-amber-900',
  skipped: 'border-slate-300 bg-slate-100 text-slate-600',
  bypassed: 'border-amber-600/45 bg-amber-600/12 text-amber-900',
  not_applicable: 'border-slate-200 bg-slate-50 text-slate-500',
};

/**
 * Prints a recorded number unchanged. `toFixed`/percentage formatting would assert a precision the
 * run never recorded, and this panel is the one place the raw persisted value has to survive.
 */
function exact(value: number | null): string {
  return value === null ? NA : String(value);
}

function SectionHeading({
  children,
  hint,
}: {
  children: string;
  hint?: string;
}) {
  return (
    <div className="mb-3">
      <h3 className="text-sm font-semibold text-slate-900">{children}</h3>
      {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

function ProvenanceTag({ children }: { children: string }) {
  return (
    <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[0.65rem] text-slate-700">
      {children}
    </span>
  );
}

function ConfidenceRow({
  observation,
}: {
  observation: ConfidenceObservation;
}) {
  return (
    <tr className="border-t border-slate-100 align-top">
      <td className="py-2 pr-3 text-xs text-slate-800">{observation.label}</td>
      <td className="py-2 pr-3 font-mono text-xs tabular-nums text-slate-900">
        {exact(observation.value)}
      </td>
      <td className="py-2 pr-3">
        <ProvenanceTag>{observation.provenance}</ProvenanceTag>
        {observation.isJudgment ? null : (
          <span className="ml-1.5 text-[0.65rem] text-slate-500">
            not a judgment
          </span>
        )}
      </td>
      <td className="py-2 pr-3 font-mono text-xs tabular-nums text-slate-700">
        {observation.preCapValue === null ? (
          <span className="text-slate-400">—</span>
        ) : (
          <>
            {exact(observation.preCapValue)}{' '}
            <span className="text-[0.65rem] text-slate-500">
              ({observation.preCapProvenance ?? 'unknown'})
            </span>
          </>
        )}
      </td>
      <td className="py-2 font-mono text-[0.65rem] text-slate-500">
        {observation.source}
        {observation.note ? (
          <span className="mt-0.5 block font-sans text-[0.65rem] text-slate-500">
            {observation.note}
          </span>
        ) : null}
      </td>
    </tr>
  );
}

function ProvenanceGroupRow({ group }: { group: ConfidenceProvenanceGroup }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2 rounded-xl border border-slate-100 bg-white px-3 py-2">
      <ProvenanceTag>{group.provenance}</ProvenanceTag>
      <span className="text-xs text-slate-500">
        {group.count} value{group.count === 1 ? '' : 's'}
      </span>
      <span className="font-mono text-xs tabular-nums text-slate-800">
        min {exact(group.min)} · max {exact(group.max)} · mean{' '}
        {exact(group.mean)}
      </span>
      <span className="ml-auto text-[0.65rem] text-slate-500">
        {group.isJudgment ? 'model judgment' : 'constant / cap / self-score'}
      </span>
    </div>
  );
}

function NodeRow({ node }: { node: DecisionNodeCoverageRow }) {
  return (
    <tr className="border-t border-slate-100 align-top">
      <td className="py-2.5 pr-3">
        <p className="text-xs font-medium text-slate-900">{node.label}</p>
        <p className="font-mono text-[0.65rem] text-slate-500">{node.id}</p>
      </td>
      <td className="py-2.5 pr-3">
        <Badge className={STATUS_STYLES[node.status]} variant="outline">
          {node.status}
        </Badge>
      </td>
      <td className="py-2.5 pr-3 text-xs text-slate-700">
        <p>{node.detail}</p>
        <p className="mt-1 text-[0.65rem] text-slate-500">
          {node.changesOutcome}
        </p>
        {node.records.length > 0 ? (
          <ul className="mt-1.5 space-y-1">
            {node.records.map((record, index) => (
              <li
                className="break-words rounded-lg bg-slate-50 px-2 py-1 text-[0.65rem] text-slate-700"
                key={`${record.gate}:${index}`}
              >
                <span className="font-mono">{record.gate}</span> →{' '}
                <span className="font-mono">{record.verdict}</span>
                {/* Verbatim: a gate effect can quote a label/SDS value. */}
                <span className="mt-0.5 block whitespace-pre-wrap">
                  {record.effect}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </td>
      <td className="py-2.5 font-mono text-[0.65rem] text-slate-500">
        {node.evidence.length > 0 ? (
          node.evidence.map((path) => (
            <span className="block break-all" key={path}>
              {path}
            </span>
          ))
        ) : (
          <span className="text-slate-400">
            no record persisted — expected at {node.recordedAt}
          </span>
        )}
      </td>
    </tr>
  );
}

export function RunIntegrityPanel({ view }: { view: RunIntegrityView }) {
  const { confidenceByProvenance, confidences, nodes, retrieval, similarity } =
    view;
  const unmeasuredCount = view.unmeasuredNodeIds.length;

  return (
    <details
      className="group overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm"
      open={unmeasuredCount > 0}
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-8 py-6 hover:bg-slate-50">
        <h2 className="text-lg font-semibold text-slate-900">
          Confidence &amp; similarity integrity
        </h2>
        <Badge
          className="border-slate-300 bg-slate-100 text-slate-600"
          variant="outline"
        >
          diagnostic
        </Badge>
        {unmeasuredCount > 0 ? (
          <Badge className={STATUS_STYLES.unmeasured} variant="outline">
            {unmeasuredCount} unmeasured
          </Badge>
        ) : (
          <Badge className={STATUS_STYLES.measured} variant="outline">
            fully measured
          </Badge>
        )}
        <span className="ml-auto text-xs text-slate-500 group-open:hidden">
          <ChevronDownIcon aria-hidden className="size-4 shrink-0" />
        </span>
        <span className="ml-auto hidden text-xs text-slate-500 group-open:inline">
          <ChevronUpIcon aria-hidden className="size-4 shrink-0" />
        </span>
      </summary>

      <div className="space-y-6 border-t border-slate-100 px-8 py-6">
        <p className="rounded-2xl border border-amber-600/30 bg-amber-50/70 p-4 text-xs text-amber-900">
          Diagnostic view — not a source of record. Values are shown exactly as
          the run recorded them, with no rounding or unit conversion. Any
          dilution ratio, contact time, EPA registration number or hazard
          statement quoted in a gate effect below is reproduced verbatim from
          the run trace and must be verified against the product label or SDS
          before it is relied on.
        </p>

        {view.predatesIntegrityInstrumentation ? (
          <p className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
            This run carries none of the B0-490 – B0-494 measurement blocks. It
            predates the instrumentation, so most rows below are unmeasured —
            that is a gap in what was recorded, not evidence that these nodes
            did not run.
          </p>
        ) : null}

        {/* --- Similarity ------------------------------------------------- */}
        <section>
          <SectionHeading hint={similarity.source}>
            Retrieval similarity
          </SectionHeading>
          <dl className="grid gap-3 sm:grid-cols-3">
            {[
              {
                label: 'Raw top similarity',
                value: similarity.rawTopSimilarity,
                hint: 'pre-curation ANN top hit — what the recommendation gate calibrates against',
              },
              {
                label: 'Selected top similarity',
                value: similarity.selectedTopSimilarity,
                hint: 'best of what survived selectCuratedMatches and reached the model',
              },
              {
                label: 'Filtered out between them',
                value: similarity.droppedByFilterCount,
                hint: 'raw candidates minus surviving sources, across this turn’s search calls',
              },
            ].map((field) => (
              <div className="flex flex-col gap-0.5" key={field.label}>
                <dt className="text-xs uppercase tracking-wide text-slate-500">
                  {field.label}
                </dt>
                <dd
                  className={
                    field.value === null
                      ? 'text-xs text-slate-400'
                      : 'font-mono text-xs tabular-nums text-slate-800'
                  }
                >
                  {similarity.measured ? exact(field.value) : 'unmeasured'}
                </dd>
                <p className="text-[0.65rem] text-slate-500">{field.hint}</p>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-xs text-slate-500">{similarity.note}</p>
        </section>

        {/* --- Confidence values ------------------------------------------ */}
        <section>
          <SectionHeading hint="Every confidence recorded on this run, each with the mechanism that produced it and the value it had before any cap.">
            Confidence values
          </SectionHeading>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-left">
              <thead>
                <tr className="text-[0.65rem] uppercase tracking-wide text-slate-500">
                  <th className="pb-2 pr-3 font-medium">Measurement</th>
                  <th className="pb-2 pr-3 font-medium">Value</th>
                  <th className="pb-2 pr-3 font-medium">Provenance</th>
                  <th className="pb-2 pr-3 font-medium">Pre-cap</th>
                  <th className="pb-2 font-medium">Source field</th>
                </tr>
              </thead>
              <tbody>
                {confidences.map((observation) => (
                  <ConfidenceRow
                    key={observation.id}
                    observation={observation}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* --- Distribution by provenance (B0-492) ------------------------- */}
        <section>
          <SectionHeading hint="Grouped by provenance rather than reduced to one mean: averaging a regex-shaped constant with a model judgment is the defect this replaces.">
            Confidence distribution by provenance
          </SectionHeading>
          {confidenceByProvenance.length === 0 ? (
            <p className="text-xs text-slate-400">
              n/a — no confidence value was recorded on this run.
            </p>
          ) : (
            <div className="space-y-1.5">
              {confidenceByProvenance.map((group) => (
                <ProvenanceGroupRow group={group} key={group.provenance} />
              ))}
            </div>
          )}
        </section>

        {/* --- Decision node coverage ------------------------------------- */}
        <section>
          <SectionHeading hint="Every node that can change this run’s outcome. Code-anchored: the list is checked against gateIdSchema and activeGatesSchema by integrity-coverage.test.ts, so a new gate cannot ship unmeasured.">
            Decision node coverage
          </SectionHeading>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-left">
              <thead>
                <tr className="text-[0.65rem] uppercase tracking-wide text-slate-500">
                  <th className="pb-2 pr-3 font-medium">Node</th>
                  <th className="pb-2 pr-3 font-medium">Status</th>
                  <th className="pb-2 pr-3 font-medium">What was recorded</th>
                  <th className="pb-2 font-medium">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((node) => (
                  <NodeRow key={node.id} node={node} />
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* --- Retrieval + runtime configuration --------------------------- */}
        <section>
          <SectionHeading hint={retrieval.source}>
            Retrieval configuration used
          </SectionHeading>
          {retrieval.measured && retrieval.config ? (
            <>
              <dl className="grid gap-3 sm:grid-cols-3">
                {[
                  ['Embedding model', retrieval.config.embeddingModel],
                  ['Retrieval strategy', retrieval.config.retrievalStrategy],
                  ['Embedding source', retrieval.config.embeddingSource],
                  ['Scope', retrieval.config.scope],
                  [
                    'Min similarity floor',
                    exact(retrieval.config.minSimilarity),
                  ],
                  ['Rerank total', exact(retrieval.rerankMsTotal)],
                ].map(([label, value]) => (
                  <div className="flex flex-col gap-0.5" key={label}>
                    <dt className="text-xs uppercase tracking-wide text-slate-500">
                      {label}
                    </dt>
                    <dd
                      className={
                        value
                          ? 'font-mono text-xs text-slate-800'
                          : 'text-xs text-slate-400'
                      }
                    >
                      {value && value !== NA ? value : NA}
                    </dd>
                  </div>
                ))}
              </dl>
              {retrieval.config.mixed.length > 0 ? (
                <p className="mt-2 text-xs text-amber-800">
                  This turn’s search calls disagreed on:{' '}
                  <span className="font-mono">
                    {retrieval.config.mixed.join(', ')}
                  </span>{' '}
                  — those fields are null above rather than showing one call’s
                  value as the run’s.
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-xs text-slate-400">
              unmeasured — no retrieval configuration was recorded for this run.
            </p>
          )}

          {retrieval.runtimeConfig ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {Object.entries(retrieval.runtimeConfig).map(([key, value]) => (
                <Badge
                  className="font-mono text-[0.65rem]"
                  key={key}
                  variant="outline"
                >
                  {key}: {value === null ? 'null' : String(value)}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-xs text-slate-400">
              unmeasured — no runtime switch snapshot on this run, so which
              gates were enabled is unknown (not &ldquo;all enabled&rdquo;).
            </p>
          )}
        </section>
      </div>
    </details>
  );
}
