import {
  FORMULATION_DECISION_FIELDS,
  formulationVariantDecisionInputSchema,
  formulationVariantDecisionSchema,
  productLineFormulationFactsSchema,
  type FormulationDataGap,
  type FormulationDecisionField,
  type FormulationDisagreement,
  type FormulationVariantDecision,
  type FormulationVariantDecisionInput,
  type ProductLineFormulationFacts,
} from '~/lib/rag/formulation-variant-schemas';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * B0-486 — executable form of `src/docs/formulation-variant-aliasing-rules.md`.
 *
 * The doc has been documentation-only: nothing stopped a reviewer approving a `rag.product_alias`
 * row whose `alias_norm` maps to several `product_line_key`s, which is exactly how a concentrate
 * gets silently merged with an RTU or an "Ultra" variant carrying a *different* EPA registration
 * and dilution. This module reads the regulated facts and returns a verdict; the caller
 * (`~/lib/rag/product-alias-review-actions.ts`) blocks on it.
 *
 * Deliberately one-directional: the only outcomes are "a human may proceed", "blocked", and
 * "blocked pending a regulated-data backfill". Nothing here approves, writes, or bulk-applies
 * anything — the doc withholds authorization for bulk application until its owner signs off.
 *
 * Join path (the known trap in this codebase): `rag.product_line_fact` has **no**
 * `product_line_key` column. It has `entity_id` and `product_key`. Facts must be reached
 * `rag.entity.product_line_key` → `rag.entity.id` = `rag.product_line_fact.entity_id`. Joining on
 * `product_key` instead silently drops the `product_line`-tier fact rows (whose `product_key` is
 * null) and cannot see a line's SKU-tier rows at all.
 */

type LooseRow = Record<string, unknown>;

/**
 * Fail-closed row caps. If a read comes back at the cap the result may be truncated, and a
 * truncated fact set could make two genuinely different lines *look* like they agree. We throw
 * rather than risk emitting `may_merge` from partial regulated data.
 */
const MAX_ENTITY_ROWS = 2000;
const MAX_FACT_ROWS = 2000;
const MAX_ALIAS_ROWS = 500;

/** Loose accessor for `rag.entity` (reads only). Same convention as
 *  `~/lib/rag/product-alias-review-repository.ts`: the merged Supabase `Database` type doesn't
 *  reliably resolve `.schema('rag').from(...)` chains, so each table gets a narrow hand-typed
 *  accessor rather than fighting the generated types. */
function entityTable() {
  const sb = getSupabaseServiceRoleClient() as unknown as {
    schema: (s: 'rag') => {
      from: (t: 'entity') => {
        select: (cols: string) => {
          in: (
            c: string,
            v: unknown[],
          ) => {
            limit: (
              n: number,
            ) => PromiseLike<{ data: LooseRow[] | null; error: { message: string } | null }>;
          };
        };
      };
    };
  };
  return sb.schema('rag').from('entity');
}

/** Loose accessor for `rag.product_line_fact` (reads only — this guard never mutates fact data). */
function productLineFactTable() {
  const sb = getSupabaseServiceRoleClient() as unknown as {
    schema: (s: 'rag') => {
      from: (t: 'product_line_fact') => {
        select: (cols: string) => {
          in: (
            c: string,
            v: unknown[],
          ) => {
            limit: (
              n: number,
            ) => PromiseLike<{ data: LooseRow[] | null; error: { message: string } | null }>;
          };
        };
      };
    };
  };
  return sb.schema('rag').from('product_line_fact');
}

/** Loose accessor for `rag.product_alias` (reads only). */
function productAliasTable() {
  const sb = getSupabaseServiceRoleClient() as unknown as {
    schema: (s: 'rag') => {
      from: (t: 'product_alias') => {
        select: (cols: string) => {
          eq: (
            c: string,
            v: unknown,
          ) => {
            limit: (
              n: number,
            ) => PromiseLike<{ data: LooseRow[] | null; error: { message: string } | null }>;
          };
        };
      };
    };
  };
  return sb.schema('rag').from('product_alias');
}

const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * Carry a stored regulated value through as text **without altering it**.
 *
 * PostgREST returns `numeric` as a string, so `dilution_oz_per_gal` arrives as e.g. `"0.500"` and
 * is preserved digit-for-digit. A JS `number` (an `integer` column such as
 * `contact_time_seconds`) is stringified with no formatting, padding or rounding. Anything else,
 * and the empty string, is treated as absent — never guessed at.
 */
function exactStoredValue(raw: unknown): string | null {
  if (typeof raw === 'string') {
    return raw.trim() === '' ? null : raw;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return String(raw);
  }
  if (typeof raw === 'bigint') {
    return String(raw);
  }
  return null;
}

/**
 * Load every `rag.product_line_fact` value reachable from each `product_line_key`, aggregated
 * across all tiers of that line. A key with no `rag.entity` row at all still gets a facts record
 * (zero entities, zero fact rows) so it surfaces as a data gap rather than vanishing.
 */
export async function fetchProductLineFormulationFacts(
  productLineKeys: string[],
): Promise<ProductLineFormulationFacts[]> {
  const keys = [...new Set(productLineKeys.filter((k) => typeof k === 'string' && k.trim() !== ''))];
  if (keys.length === 0) return [];

  const entityRes = await entityTable()
    .select('id, product_line_key, entity_type, title')
    .in('product_line_key', keys)
    .limit(MAX_ENTITY_ROWS);
  if (entityRes.error) {
    throw new Error(`fetchProductLineFormulationFacts (entity) failed: ${entityRes.error.message}`);
  }
  const entityRows = entityRes.data ?? [];
  if (entityRows.length >= MAX_ENTITY_ROWS) {
    throw new Error(
      `fetchProductLineFormulationFacts: rag.entity read hit the ${MAX_ENTITY_ROWS}-row cap; refusing to decide on possibly truncated regulated data.`,
    );
  }

  const lineKeyByEntityId = new Map<string, string>();
  const titleByLineKey = new Map<string, string | null>();
  const entityCountByLineKey = new Map<string, number>();
  for (const row of entityRows) {
    const entityId = strOrNull(row.id);
    const lineKey = strOrNull(row.product_line_key);
    if (!entityId || !lineKey) continue;
    lineKeyByEntityId.set(entityId, lineKey);
    entityCountByLineKey.set(lineKey, (entityCountByLineKey.get(lineKey) ?? 0) + 1);
    if (strOrNull(row.entity_type) === 'product_line') {
      titleByLineKey.set(lineKey, strOrNull(row.title));
    }
  }

  const entityIds = [...lineKeyByEntityId.keys()];
  const factRows: LooseRow[] = [];
  if (entityIds.length > 0) {
    const factRes = await productLineFactTable()
      .select(
        'entity_id, epa_registration, dilution_display, dilution_oz_per_gal, contact_time_seconds',
      )
      .in('entity_id', entityIds)
      .limit(MAX_FACT_ROWS);
    if (factRes.error) {
      throw new Error(
        `fetchProductLineFormulationFacts (product_line_fact) failed: ${factRes.error.message}`,
      );
    }
    const rows = factRes.data ?? [];
    if (rows.length >= MAX_FACT_ROWS) {
      throw new Error(
        `fetchProductLineFormulationFacts: rag.product_line_fact read hit the ${MAX_FACT_ROWS}-row cap; refusing to decide on possibly truncated regulated data.`,
      );
    }
    factRows.push(...rows);
  }

  const valuesByLineKey = new Map<string, Map<FormulationDecisionField, Set<string>>>();
  const factCountByLineKey = new Map<string, number>();
  for (const key of keys) {
    valuesByLineKey.set(
      key,
      new Map(FORMULATION_DECISION_FIELDS.map((f) => [f, new Set<string>()])),
    );
  }

  for (const row of factRows) {
    const entityId = strOrNull(row.entity_id);
    const lineKey = entityId ? lineKeyByEntityId.get(entityId) : undefined;
    if (!lineKey) continue;
    factCountByLineKey.set(lineKey, (factCountByLineKey.get(lineKey) ?? 0) + 1);
    const perField = valuesByLineKey.get(lineKey);
    if (!perField) continue;
    for (const field of FORMULATION_DECISION_FIELDS) {
      const value = exactStoredValue(row[field]);
      if (value !== null) perField.get(field)?.add(value);
    }
  }

  return keys.map((productLineKey) => {
    const perField = valuesByLineKey.get(productLineKey);
    return productLineFormulationFactsSchema.parse({
      productLineKey,
      productLineTitle: titleByLineKey.get(productLineKey) ?? null,
      entityCount: entityCountByLineKey.get(productLineKey) ?? 0,
      factRowCount: factCountByLineKey.get(productLineKey) ?? 0,
      factsByField: FORMULATION_DECISION_FIELDS.map((field) => ({
        field,
        // Sorted for a stable comparison and a stable audit payload; sorting reorders values,
        // it never edits one.
        values: [...(perField?.get(field) ?? [])].sort(),
      })),
    });
  });
}

function valuesFor(facts: ProductLineFormulationFacts, field: FormulationDecisionField): string[] {
  return facts.factsByField.find((entry) => entry.field === field)?.values ?? [];
}

/** A line can be judged only with an EPA registration *and* a dilution, per the doc's table. */
function missingDecisionFields(facts: ProductLineFormulationFacts): FormulationDecisionField[] {
  return FORMULATION_DECISION_FIELDS.filter((field) => valuesFor(facts, field).length === 0);
}

/**
 * The doc decides a merge on EPA registration and dilution. A line missing either cannot be
 * judged — that is the "insufficient data" branch, not a licence to fall back on the name.
 * A missing `contact_time_seconds` alone does not block (it is reported in `missingFields` for the
 * reviewer, but plenty of legitimately comparable rows carry no contact time).
 */
function isDecidable(facts: ProductLineFormulationFacts): boolean {
  const hasEpa = valuesFor(facts, 'epa_registration').length > 0;
  const hasDilution =
    valuesFor(facts, 'dilution_display').length > 0 ||
    valuesFor(facts, 'dilution_oz_per_gal').length > 0;
  return facts.factRowCount > 0 && hasEpa && hasDilution;
}

const sameValues = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((value, i) => value === b[i]);

function describeValues(values: string[]): string {
  return values.length === 0 ? '(none)' : values.join(' / ');
}

/**
 * The rule itself — pure, so it is unit-testable without a database.
 *
 * Precedence: a definitive disagreement outranks a data gap when both are present, because it is
 * the stronger true statement about the same set of candidates. Both outcomes block, so the
 * ordering changes the reviewer's explanation, never the safety of the answer. Data gaps are
 * reported alongside a `must_not_merge` verdict so they are never lost.
 */
export function decideFormulationVariantMerge(
  rawInput: FormulationVariantDecisionInput,
): FormulationVariantDecision {
  const input = formulationVariantDecisionInputSchema.parse(rawInput);
  const { facts, aliasNorm } = input;
  const productLineKeys = facts.map((f) => f.productLineKey);

  const dataGaps: FormulationDataGap[] = facts
    .filter((f) => !isDecidable(f))
    .map((f) => ({
      productLineKey: f.productLineKey,
      productLineTitle: f.productLineTitle,
      hasAnyFactRow: f.factRowCount > 0,
      missingFields: missingDecisionFields(f),
    }));

  // Fewer than two candidate lines is not a merge at all — nothing to compare.
  if (facts.length < 2) {
    return formulationVariantDecisionSchema.parse({
      verdict: 'may_merge',
      aliasNorm,
      productLineKeys,
      reason:
        'Alias maps to a single product line, so no formulation-variant merge is being made; the formulation-variant rule does not apply.',
      disagreements: [],
      dataGaps: [],
      facts,
    });
  }

  const comparable = facts.filter(isDecidable);
  const disagreements: FormulationDisagreement[] = [];
  for (const field of FORMULATION_DECISION_FIELDS) {
    // Only lines that actually carry the field are compared — an absent value is a gap, never a
    // mismatch, so a missing field can't be dressed up as a disagreement (or vice versa).
    const present = comparable.filter((f) => valuesFor(f, field).length > 0);
    if (present.length < 2) continue;
    const first = valuesFor(present[0], field);
    if (present.every((f) => sameValues(valuesFor(f, field), first))) continue;
    disagreements.push({
      field,
      byProductLine: present.map((f) => ({
        productLineKey: f.productLineKey,
        productLineTitle: f.productLineTitle,
        values: valuesFor(f, field),
      })),
    });
  }

  if (disagreements.length > 0) {
    const detail = disagreements
      .map(
        (d) =>
          `${d.field}: ${d.byProductLine
            .map((line) => `${line.productLineTitle ?? line.productLineKey} = ${describeValues(line.values)}`)
            .join(' vs. ')}`,
      )
      .join('; ');
    return formulationVariantDecisionSchema.parse({
      verdict: 'must_not_merge',
      aliasNorm,
      productLineKeys,
      reason: `These product lines disagree on regulated formulation data, so they must never share an alias — ${detail}.`,
      disagreements,
      dataGaps,
      facts,
    });
  }

  if (dataGaps.length > 0) {
    const detail = dataGaps
      .map((gap) => {
        const label = gap.productLineTitle ?? gap.productLineKey;
        const missing = gap.missingFields.join(', ') || 'none';
        return gap.hasAnyFactRow
          ? `${label} is missing ${missing}`
          : `${label} has no product_line_fact row at all`;
      })
      .join('; ');
    return formulationVariantDecisionSchema.parse({
      verdict: 'insufficient_data',
      aliasNorm,
      productLineKeys,
      reason: `Regulated formulation data is incomplete, so this merge defaults to blocked pending a backfill — ${detail}. Do not infer the missing values.`,
      disagreements: [],
      dataGaps,
      facts,
    });
  }

  const agreed = FORMULATION_DECISION_FIELDS.filter(
    (field) => valuesFor(facts[0], field).length > 0,
  )
    .map((field) => `${field} = ${describeValues(valuesFor(facts[0], field))}`)
    .join('; ');
  return formulationVariantDecisionSchema.parse({
    verdict: 'may_merge',
    aliasNorm,
    productLineKeys,
    reason: `All candidate product lines carry matching regulated formulation data (${agreed}), so the rule permits a shared alias. Reviewer confirmation is still required.`,
    disagreements: [],
    dataGaps: [],
    facts,
  });
}

export type AliasMergeCandidates = {
  aliasId: string;
  alias: string;
  aliasNorm: string;
  /** Every distinct `product_line_key` currently mapped to this `alias_norm`. */
  productLineKeys: string[];
};

/**
 * Every `product_line_key` that the alias row's `alias_norm` currently maps to — i.e. exactly what
 * `rag.product_alias_conflicts` reports for that norm, but scoped to one norm.
 *
 * Read here rather than through the review repository so this guard has no dependency on the
 * review queue's list query (and can be reused by any other caller that resolves aliases).
 */
export async function loadAliasMergeCandidates(aliasId: string): Promise<AliasMergeCandidates> {
  const rowRes = await productAliasTable().select('id, alias, alias_norm').eq('id', aliasId).limit(2);
  if (rowRes.error) {
    throw new Error(`loadAliasMergeCandidates failed: ${rowRes.error.message}`);
  }
  const row = (rowRes.data ?? [])[0];
  if (!row) {
    throw new Error(`loadAliasMergeCandidates failed: alias ${aliasId} not found`);
  }
  const aliasNorm = strOrNull(row.alias_norm) ?? '';

  const siblingRes = await productAliasTable()
    .select('product_line_key')
    .eq('alias_norm', aliasNorm)
    .limit(MAX_ALIAS_ROWS);
  if (siblingRes.error) {
    throw new Error(`loadAliasMergeCandidates failed: ${siblingRes.error.message}`);
  }
  const siblings = siblingRes.data ?? [];
  if (siblings.length >= MAX_ALIAS_ROWS) {
    throw new Error(
      `loadAliasMergeCandidates: rag.product_alias read hit the ${MAX_ALIAS_ROWS}-row cap for alias_norm "${aliasNorm}"; refusing to decide on a possibly truncated candidate set.`,
    );
  }

  const productLineKeys = [
    ...new Set(
      siblings
        .map((sibling) => strOrNull(sibling.product_line_key))
        .filter((key): key is string => key !== null && key.trim() !== ''),
    ),
  ];

  return {
    aliasId: String(row.id),
    alias: strOrNull(row.alias) ?? '',
    aliasNorm,
    productLineKeys,
  };
}

/**
 * Full guard for one alias row: resolve the `product_line_key`s sharing its `alias_norm`, load
 * their regulated facts, apply the rule.
 */
export async function evaluateAliasFormulationVariantMerge(
  aliasId: string,
): Promise<FormulationVariantDecision & { alias: string }> {
  const candidates = await loadAliasMergeCandidates(aliasId);
  const facts = await fetchProductLineFormulationFacts(candidates.productLineKeys);
  const decision = decideFormulationVariantMerge({ aliasNorm: candidates.aliasNorm, facts });
  return { ...decision, alias: candidates.alias };
}

/*
 * A blocked approval is returned as a value, not thrown — see `ApproveProductAliasResult` in
 * `~/lib/rag/product-alias-review-actions.ts`. Next.js redacts thrown Server Action messages in
 * production builds, so a thrown error would have hidden this guard's field-by-field reason from
 * the reviewer who needs it.
 */
