import { Badge } from '~/components/ui/badge';
import {
  formatMultiTurnBadgeLabel,
  readMultiTurnItemView,
} from '~/lib/tests/multi-turn-display';
import type { MultiTurnScenario, ScenarioAssertion } from '~/lib/tests/multi-turn';

/**
 * B0-537 — read-only view of a test item's declared multi-turn scenario (the ordered turns and the
 * cross-turn assertions), for the item detail page. Renders nothing for a single-turn row, so the
 * page is unchanged for the entire pre-B0-537 corpus.
 *
 * Expectation values are printed verbatim, never reformatted — `must_mention` can legitimately
 * carry a figure transcribed off a label, and the evaluator matches those literally.
 */

function assertionScope(assertion: ScenarioAssertion): string {
  switch (assertion.type) {
    case 'context_carry':
      return `turn ${assertion.from_turn} → turn ${assertion.turn}`;
    case 'consistent_product_anchor':
      return `turn ${assertion.from_turn ?? 1} onward`;
    default:
      return `turn ${assertion.turn}`;
  }
}

function assertionDetail(assertion: ScenarioAssertion): string {
  switch (assertion.type) {
    case 'context_carry':
      return `anchor "${assertion.anchor}"${assertion.aliases?.length ? ` (aliases: ${assertion.aliases.join(', ')})` : ''}`;
    case 'no_reask':
      return `must not re-ask for: ${assertion.already_provided.join(', ')}`;
    case 'consistent_product_anchor':
      return [
        `product "${assertion.product}"`,
        assertion.require_mention ? 'must be named in every non-decline turn' : null,
        assertion.disallowed_products?.length
          ? `must not switch to: ${assertion.disallowed_products.join(', ')}`
          : null,
      ]
        .filter(Boolean)
        .join(' · ');
    case 'mentions':
      return `must mention any of: ${assertion.any_of.join(', ')}`;
    case 'not_mentions':
      return `must mention none of: ${assertion.none_of.join(', ')}`;
  }
}

function TurnExpectations({ scenario, index }: { scenario: MultiTurnScenario; index: number }) {
  const expectations = scenario.turns[index]?.expectations;
  if (!expectations) {
    return <span className="text-xs text-slate-400">No per-turn expectation</span>;
  }

  // B0-933 — per-turn `should_answer` / `expected_result_type` expectations were retired from the
  // multi-turn schema along with the `test_items` columns they mirrored; only the mention
  // expectations remain gradeable.
  const chips: string[] = [];
  if (expectations.must_mention?.length) {
    chips.push(`must mention: ${expectations.must_mention.join(', ')}`);
  }
  if (expectations.must_not_mention?.length) {
    chips.push(`must not mention: ${expectations.must_not_mention.join(', ')}`);
  }

  if (chips.length === 0) {
    return <span className="text-xs text-slate-400">No per-turn expectation</span>;
  }

  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((chip) => (
        <Badge className="text-slate-600" key={chip} variant="secondary">
          {chip}
        </Badge>
      ))}
    </div>
  );
}

export function MultiTurnScenarioCard({ inputPayload }: { inputPayload: unknown }) {
  const view = readMultiTurnItemView(inputPayload);

  if (view.kind === 'single_turn') {
    return null;
  }

  if (view.kind === 'invalid') {
    return (
      <section className="rounded-3xl border border-red-200 bg-red-50/60 p-6">
        <h2 className="text-sm font-semibold text-red-900">Multi-turn scenario — invalid</h2>
        <p className="mt-2 text-sm text-red-800">{view.message}</p>
        <p className="mt-2 text-xs text-red-700">
          This row will be recorded as failed on the next run instead of being silently treated as a
          single-turn prompt. Fix it with Edit prompt on the dataset page.
        </p>
      </section>
    );
  }

  const { scenario } = view;

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            {scenario.title || 'Multi-turn scenario'}
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            {formatMultiTurnBadgeLabel(view.turnCount)}
            {scenario.scenario_id ? ` · ${scenario.scenario_id}` : ''} · replayed in a single
            conversation, in order
          </p>
        </div>
        <Badge
          className="border-sky-600/45 bg-sky-600/12 text-sky-900 dark:border-sky-500/40 dark:bg-sky-500/15 dark:text-sky-50"
          variant="outline"
        >
          {formatMultiTurnBadgeLabel(view.turnCount)}
        </Badge>
      </div>

      <ol className="mt-4 flex flex-col gap-3">
        {scenario.turns.map((turn, index) => (
          <li
            className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4"
            key={`${index}-${turn.prompt.slice(0, 24)}`}
          >
            <div className="flex items-start gap-3">
              <Badge className="mt-0.5 shrink-0 text-slate-600" variant="secondary">
                Turn {index + 1}
              </Badge>
              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap text-sm text-slate-800">{turn.prompt}</p>
                <div className="mt-2">
                  <TurnExpectations index={index} scenario={scenario} />
                </div>
                {turn.expectations?.note ? (
                  <p className="mt-2 text-xs italic text-slate-500">{turn.expectations.note}</p>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ol>

      {scenario.assertions?.length ? (
        <div className="mt-5 border-t border-slate-200 pt-4">
          <h3 className="text-sm font-semibold text-slate-900">
            Cross-turn assertions ({scenario.assertions.length})
          </h3>
          <ul className="mt-2 flex flex-col gap-2">
            {scenario.assertions.map((assertion, index) => (
              <li className="text-xs text-slate-700" key={`${assertion.type}-${index}`}>
                <Badge className="mr-2 align-middle font-mono" variant="outline">
                  {assertion.type}
                </Badge>
                <span className="text-slate-500">{assertionScope(assertion)}</span>{' '}
                — {assertionDetail(assertion)}
                {assertion.description ? (
                  <span className="text-slate-500"> · {assertion.description}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
