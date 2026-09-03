import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * Typed, cited product facts joined deterministically at retrieval time (B0-185).
 * Keyed on rag.entity(id) — the same key the product-line resolver already locks onto.
 * Facts are NEVER embedded; they are looked up by id and rendered as grounded evidence.
 */
export type ProductEfficacyFact = {
  organism: string;
  claimType: string | null;
  dilutionOzPerGal: number | null;
  contactTimeSeconds: number | null;
  epaRegistration: string | null;
  /** B0-257: row-level confidence from rag.product_efficacy.confidence (default 1.0 = verified/source-of-record). */
  confidence: number | null;
};

export type ProductLineFacts = {
  entityId: string;
  dilutionOzPerGal: number | null;
  dilutionDisplay: string | null;
  coverageSqFt: number | null;
  chemistryClass: string | null;
  productApplication: string | null;
  /** Confidence for productApplication specifically (B0-263) -- classifier-derived, never 1.0. Null when productApplication is null. */
  productApplicationConfidence: number | null;
  epaRegistration: string | null;
  contactTimeSeconds: number | null;
  /**
   * B0-257: row-level confidence from rag.product_line_fact.confidence, covering the
   * dilution/coverage/chemistry/EPA-reg/contact-time columns above (default 1.0 =
   * verified/source-of-record; product_application has its own separate confidence
   * field since it's classifier-derived, not a stamped fact -- see B0-263 above).
   */
  confidence: number;
  efficacy: ProductEfficacyFact[];
};

const PRODUCT_LINE_FACT_COLUMNS =
  'entity_id, product_key, dilution_oz_per_gal, dilution_display, coverage_sq_ft, chemistry_class, product_application, product_application_confidence, epa_registration, contact_time_seconds, confidence';

const PRODUCT_EFFICACY_COLUMNS =
  'entity_id, organism, claim_type, dilution_oz_per_gal, contact_time_seconds, epa_registration, confidence';

type FactRow = {
  entity_id: string;
  /** NULL on product_line-tier rows; the SKU's product_key on product-tier rows. */
  product_key: string | null;
  dilution_oz_per_gal: number | null;
  dilution_display: string | null;
  coverage_sq_ft: number | null;
  chemistry_class: string | null;
  product_application: string | null;
  product_application_confidence: number | null;
  epa_registration: string | null;
  contact_time_seconds: number | null;
  confidence: number;
};

type EfficacyRow = {
  entity_id: string;
  organism: string;
  claim_type: string | null;
  dilution_oz_per_gal: number | null;
  contact_time_seconds: number | null;
  epa_registration: string | null;
  confidence: number | null;
};

/**
 * One round trip (two parallel statements) for the fact + efficacy rows of any set of entity ids,
 * across BOTH tiers — no `product_key IS NULL` predicate, so product-tier fact rows come back too.
 * Tier partitioning happens in memory (see `fetchProductLineFacts` and the B0-634 merge below).
 * Returns null on error so callers can degrade instead of blocking retrieval.
 */
async function fetchFactAndEfficacyRows(
  entityIds: string[],
): Promise<{ factRows: FactRow[]; efficacyRows: EfficacyRow[] } | null> {
  const rag = getSupabaseServiceRoleClient().schema('rag');
  const [factsRes, efficacyRes] = await Promise.all([
    rag.from('product_line_fact').select(PRODUCT_LINE_FACT_COLUMNS).in('entity_id', entityIds),
    rag.from('product_efficacy').select(PRODUCT_EFFICACY_COLUMNS).in('entity_id', entityIds),
  ]);

  if (factsRes.error || efficacyRes.error) {
    return null;
  }

  return {
    factRows: (factsRes.data ?? []) as FactRow[],
    efficacyRows: (efficacyRes.data ?? []) as EfficacyRow[],
  };
}

function toEfficacyFact(row: EfficacyRow): ProductEfficacyFact {
  return {
    organism: row.organism,
    claimType: row.claim_type,
    dilutionOzPerGal: row.dilution_oz_per_gal,
    contactTimeSeconds: row.contact_time_seconds,
    epaRegistration: row.epa_registration,
    confidence: row.confidence,
  };
}

function groupEfficacyByEntity(rows: EfficacyRow[]): Map<string, ProductEfficacyFact[]> {
  const byEntity = new Map<string, ProductEfficacyFact[]>();
  for (const row of rows) {
    const list = byEntity.get(row.entity_id) ?? [];
    list.push(toEfficacyFact(row));
    byEntity.set(row.entity_id, list);
  }
  return byEntity;
}

function factsFromRow(row: FactRow, efficacy: ProductEfficacyFact[]): ProductLineFacts {
  return {
    entityId: row.entity_id,
    dilutionOzPerGal: row.dilution_oz_per_gal,
    dilutionDisplay: row.dilution_display,
    coverageSqFt: row.coverage_sq_ft,
    chemistryClass: row.chemistry_class,
    productApplication: row.product_application,
    productApplicationConfidence: row.product_application_confidence,
    epaRegistration: row.epa_registration,
    contactTimeSeconds: row.contact_time_seconds,
    confidence: row.confidence,
    efficacy,
  };
}

function factsWithoutScalarRow(entityId: string, efficacy: ProductEfficacyFact[]): ProductLineFacts {
  return {
    entityId,
    dilutionOzPerGal: null,
    dilutionDisplay: null,
    coverageSqFt: null,
    chemistryClass: null,
    productApplication: null,
    productApplicationConfidence: null,
    epaRegistration: null,
    contactTimeSeconds: null,
    // No product_line_fact row for this entity -- confidence defaults to the same
    // 1.0 baseline the column itself defaults to, since there's no lower-confidence
    // signal without a row.
    confidence: 1,
    efficacy,
  };
}

/** Fetch line-level facts + efficacy rows for a set of entity ids. Degrades to an empty map on error. */
export async function fetchProductLineFacts(
  entityIds: string[],
): Promise<Map<string, ProductLineFacts>> {
  const unique = [...new Set(entityIds.filter(Boolean))];
  const map = new Map<string, ProductLineFacts>();
  if (unique.length === 0) {
    return map;
  }

  const rows = await fetchFactAndEfficacyRows(unique);
  if (!rows) {
    return map; // grounding degrades gracefully — never block retrieval on a facts miss
  }

  const efficacyByEntity = groupEfficacyByEntity(rows.efficacyRows);

  // Line-tier scalars only (`product_key IS NULL`) — same predicate as before, applied in memory
  // so the shared query above can also serve the B0-634 product-tier lookup.
  for (const row of rows.factRows) {
    if (row.product_key != null) continue;
    map.set(row.entity_id, factsFromRow(row, efficacyByEntity.get(row.entity_id) ?? []));
  }

  // Entities with efficacy rows but no scalar fact row still get an entry.
  for (const [entityId, efficacy] of efficacyByEntity) {
    if (!map.has(entityId)) {
      map.set(entityId, factsWithoutScalarRow(entityId, efficacy));
    }
  }

  return map;
}

/**
 * B0-634 — the scalars that participate in the cross-tier merge, with the comparison kind used to
 * decide whether two product-tier values *agree*.
 *
 * `numeric` compares the stored Postgres numeric canonically (`5` and `5.000` are the same stored
 * number — normalising insignificant zeros is not rounding); `text` compares the stored string
 * exactly, byte for byte. Values from different columns are never compared to each other, so a
 * `dilution_display` of `"1:64"` is never coerced into equivalence with a `dilution_oz_per_gal` of
 * `2.000`. Nothing is rounded, unit-converted, or inferred.
 */
const MERGED_SCALARS = [
  { field: 'dilutionOzPerGal', column: 'dilution_oz_per_gal', kind: 'numeric' },
  { field: 'dilutionDisplay', column: 'dilution_display', kind: 'text' },
  { field: 'coverageSqFt', column: 'coverage_sq_ft', kind: 'numeric' },
  { field: 'chemistryClass', column: 'chemistry_class', kind: 'text' },
  { field: 'productApplication', column: 'product_application', kind: 'text' },
  { field: 'epaRegistration', column: 'epa_registration', kind: 'text' },
  { field: 'contactTimeSeconds', column: 'contact_time_seconds', kind: 'numeric' },
] as const satisfies readonly {
  field: keyof ProductLineFacts;
  column: keyof FactRow;
  kind: 'numeric' | 'text';
}[];

/**
 * Canonical form of a Postgres numeric for *equality only*. Strips the sign of zero and
 * insignificant zeros (`5` / `5.0` / `05.000` → `5`) so two spellings of the same stored number
 * count as agreement. Anything that isn't a plain decimal (including exponent notation) falls back
 * to the raw string, so it can only ever match an identical raw string. Never used to reformat a
 * value that is returned to callers.
 */
function canonicalNumeric(value: number | string): string {
  const raw = typeof value === 'number' ? String(value) : value.trim();
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!match || (!match[2] && !match[3])) {
    return `raw:${raw}`;
  }
  const integer = (match[2] ?? '').replace(/^0+/, '') || '0';
  const fraction = (match[3] ?? '').replace(/0+$/, '');
  const magnitude = fraction ? `${integer}.${fraction}` : integer;
  const sign = match[1] === '-' && magnitude !== '0' ? '-' : '';
  return `${sign}${magnitude}`;
}

function canonicalValue(value: unknown, kind: 'numeric' | 'text'): string {
  if (kind === 'numeric' && (typeof value === 'number' || typeof value === 'string')) {
    return `n:${canonicalNumeric(value)}`;
  }
  return `t:${String(value)}`;
}

/**
 * Dedupe identity for an efficacy row: organism + claim type + the regulated scalars. Two rows that
 * differ on contact time, dilution, or EPA registration are DIFFERENT claims and both survive the
 * cross-tier union — collapsing them would fabricate a regulated figure.
 */
function efficacyDedupeKey(e: ProductEfficacyFact): string {
  return [
    e.organism,
    e.claimType ?? '',
    e.dilutionOzPerGal == null ? '' : canonicalNumeric(e.dilutionOzPerGal),
    e.contactTimeSeconds == null ? '' : canonicalNumeric(e.contactTimeSeconds),
    e.epaRegistration ?? '',
  ].join('');
}

/**
 * B0-634 — agree-or-abstain merge of product-tier facts onto a product_line-tier base.
 *
 * Some product lines carry their regulated scalars on the product (SKU) tier rather than the line
 * tier — "Push" holds `dilution_oz_per_gal = 5` on its two product-tier entities while the
 * product_line-tier row leaves it null. The rules, in order:
 *
 *  1. A non-null line-tier value is authoritative and is NEVER overwritten by a product-tier value.
 *  2. For a still-null scalar, if every non-null product-tier value agrees, adopt it — returned
 *     exactly as stored, never reformatted.
 *  3. If the non-null product-tier values disagree, leave it null. Differing dilution / EPA /
 *     contact-time values across variants mean genuinely different formulations (see
 *     `src/docs/formulation-variant-aliasing-rules.md`, pH7Q family), so picking one — or averaging
 *     them — would fabricate a regulated figure. Abstain instead.
 *  4. Efficacy rows are UNIONed across tiers and deduped on organism + claim type + regulated
 *     scalars, never field-merged: the same organism at two different contact times keeps both rows.
 */
function mergeProductTierFacts(
  base: ProductLineFacts,
  productTierRows: FactRow[],
  productTierEfficacy: ProductEfficacyFact[],
): ProductLineFacts {
  if (productTierRows.length === 0 && productTierEfficacy.length === 0) {
    return base;
  }

  const merged: ProductLineFacts = { ...base };
  const contributingConfidences: number[] = [];
  let adoptedApplicationFrom: FactRow[] = [];

  for (const { field, column, kind } of MERGED_SCALARS) {
    if (merged[field] != null) continue; // rule 1 — line tier wins outright

    const candidates = productTierRows.filter((row) => row[column] != null);
    if (candidates.length === 0) continue;

    const canon = canonicalValue(candidates[0]![column], kind);
    if (candidates.some((row) => canonicalValue(row[column], kind) !== canon)) {
      continue; // rule 3 — disagreement, abstain rather than pick
    }

    // rule 2 — adopt the value exactly as stored
    (merged as Record<string, unknown>)[field] = candidates[0]![column];
    for (const row of candidates) contributingConfidences.push(row.confidence);
    if (field === 'productApplication') adoptedApplicationFrom = candidates;
  }

  if (adoptedApplicationFrom.length > 0) {
    // product_application carries its own classifier confidence — carry the (lowest) one that came
    // with the adopted value rather than leaving it null, which would read as "unknown".
    const applicationConfidences = adoptedApplicationFrom
      .map((row) => row.product_application_confidence)
      .filter((c): c is number => c != null);
    merged.productApplicationConfidence =
      applicationConfidences.length > 0 ? Math.min(...applicationConfidences) : null;
  }

  if (contributingConfidences.length > 0) {
    // The single `confidence` scalar covers several columns at once, so once a product-tier value is
    // adopted the block can be no more certain than the least certain row behind it.
    merged.confidence = Math.min(merged.confidence, ...contributingConfidences);
  }

  // rule 4 — union + dedupe, line tier first so its rows win the dedupe.
  const seen = new Set<string>();
  const efficacy: ProductEfficacyFact[] = [];
  for (const fact of [...base.efficacy, ...productTierEfficacy]) {
    const key = efficacyDedupeKey(fact);
    if (seen.has(key)) continue;
    seen.add(key);
    efficacy.push(fact);
  }
  merged.efficacy = efficacy;

  return merged;
}

function filterEfficacyByOrganism(facts: ProductLineFacts, needle?: string): ProductLineFacts {
  if (!needle) return facts;
  return {
    ...facts,
    efficacy: facts.efficacy.filter((e) => e.organism.toLowerCase().includes(needle)),
  };
}

/**
 * Fact-only lookup for a single product line resolved by product_line_key.
 * Returns null when the line can't be resolved or has no verified facts.
 * `organism` optionally filters the efficacy rows (case-insensitive contains).
 *
 * B0-634: delegates to the batch resolver so both paths share one tier-aware merge — same two round
 * trips as before (one entity query, one facts/efficacy query).
 *
 * B0-792 — this merges product-tier facts from EVERY product sharing `productLineKey`, which is
 * correct only when `product_line_key` is a trustworthy grouping. At least one grouping
 * (`product_line_key` "Drain Maintainer", 1FFF1D45-36AC-4D67-9BC5-CDC8626830E3) has been confirmed
 * to bucket ~10 unrelated finished-goods products together (a source-ERP mapping-gap defect: the
 * legacy `DSLProdLn`/`prod_line_id` code these were ingested against, "2607", is reused/coincidental
 * across unrelated legacy SKUs — see the ingestion joins in
 * `supabase/migrations/20260723120000_backfill_active_product_entities.sql` and
 * `20260723130000_link_active_product_entities_to_lines.sql`). Callers that have already resolved a
 * SPECIFIC product (a `productKey`) must call `fetchFactsForProduct` instead, which pins to that
 * product's own tier rows and only merges the broader group when no specific product was resolved.
 */
export async function fetchFactsForProductLineKey(
  productLineKey: string,
  organism?: string,
): Promise<ProductLineFacts | null> {
  const byKey = await fetchFactsForProductLineKeys([productLineKey], organism);
  return byKey.get(productLineKey) ?? null;
}

/** One {productLineKey, productKey} lookup request for `fetchFactsForProductBatch`. */
export type ProductFactsRequest = {
  productLineKey: string;
  /** The specific resolved SKU/product entity's `product_key`, or null when only a line was resolved. */
  productKey: string | null;
};

/**
 * B0-792 — batched counterpart to `fetchFactsForProduct`: resolves N `{productLineKey, productKey}`
 * requests in two round trips total (one entity lookup, one facts/efficacy lookup), returning
 * results ALIGNED BY INDEX with the input array (not deduped/keyed by product_line_key, since two
 * requests can legitimately share a `productLineKey` but pin to different `productKey`s).
 *
 * For each request: when `productKey` is set, product-tier facts are pinned to THAT product's own
 * entity row only — never every sibling entity sharing `productLineKey`. This is the fix for the
 * cross-product-citation bug: a bogus/over-broad `product_line_key` grouping can no longer leak one
 * product's dilution/efficacy figure into another's answer, as long as the caller resolved a
 * specific product. When `productKey` is null (no specific product resolved), behavior is
 * unchanged from the pre-B0-792 line-wide merge — this is the documented, intentional fallback.
 */
export async function fetchFactsForProductBatch(
  requests: ProductFactsRequest[],
  organism?: string,
): Promise<(ProductLineFacts | null)[]> {
  if (requests.length === 0) {
    return [];
  }

  const rag = getSupabaseServiceRoleClient().schema('rag');
  const lineKeys = [...new Set(requests.map((r) => r.productLineKey).filter((k) => k && k.trim()))];
  const productKeys = [
    ...new Set(requests.map((r) => r.productKey).filter((k): k is string => Boolean(k && k.trim()))),
  ];

  const [lineEntitiesRes, productEntitiesRes] = await Promise.all([
    lineKeys.length > 0
      ? rag
          .from('entity')
          .select('id, product_line_key')
          .eq('entity_type', 'product_line')
          .in('product_line_key', lineKeys)
      : Promise.resolve({ data: [] as { id: string; product_line_key: string | null }[], error: null }),
    productKeys.length > 0
      ? rag.from('entity').select('id, product_key').eq('entity_type', 'product').in('product_key', productKeys)
      : Promise.resolve({ data: [] as { id: string; product_key: string | null }[], error: null }),
  ]);

  const lineEntityIdByKey = new Map<string, string>();
  for (const row of lineEntitiesRes.data ?? []) {
    if (row.product_line_key && !lineEntityIdByKey.has(row.product_line_key)) {
      lineEntityIdByKey.set(row.product_line_key, row.id);
    }
  }
  const productEntityIdByKey = new Map<string, string>();
  for (const row of productEntitiesRes.data ?? []) {
    if (row.product_key && !productEntityIdByKey.has(row.product_key)) {
      productEntityIdByKey.set(row.product_key, row.id);
    }
  }

  const entityIds = new Set<string>();
  for (const id of lineEntityIdByKey.values()) entityIds.add(id);
  for (const id of productEntityIdByKey.values()) entityIds.add(id);

  const rows = entityIds.size > 0 ? await fetchFactAndEfficacyRows([...entityIds]) : null;
  const efficacyByEntity = rows ? groupEfficacyByEntity(rows.efficacyRows) : new Map<string, ProductEfficacyFact[]>();
  const factRowsByEntity = new Map<string, FactRow[]>();
  if (rows) {
    for (const row of rows.factRows) {
      const list = factRowsByEntity.get(row.entity_id) ?? [];
      list.push(row);
      factRowsByEntity.set(row.entity_id, list);
    }
  }

  const needle = organism?.trim().toLowerCase();

  return requests.map(({ productLineKey, productKey }) => {
    const lineEntityId = lineEntityIdByKey.get(productLineKey) ?? null;
    const productEntityId = productKey ? productEntityIdByKey.get(productKey) ?? null : null;
    if (!lineEntityId && !productEntityId) {
      return null;
    }

    // Line tier is the base, exactly as in fetchFactsForProductLineKeys.
    const lineRow = lineEntityId
      ? (factRowsByEntity.get(lineEntityId) ?? []).find((row) => row.product_key == null)
      : undefined;
    const lineEfficacy = lineEntityId ? efficacyByEntity.get(lineEntityId) ?? [] : [];
    const base = lineRow
      ? factsFromRow(lineRow, lineEfficacy)
      : factsWithoutScalarRow(lineEntityId ?? productEntityId!, lineEfficacy);

    // B0-792 — pinned: only THIS product's own tier rows contribute, never every sibling entity
    // that happens to share `productLineKey`.
    const productTierRows = productEntityId ? factRowsByEntity.get(productEntityId) ?? [] : [];
    const productTierEfficacy = productEntityId ? efficacyByEntity.get(productEntityId) ?? [] : [];

    const merged = mergeProductTierFacts(base, productTierRows, productTierEfficacy);
    const filtered = filterEfficacyByOrganism(merged, needle);
    return hasAnyScalar(filtered) ? filtered : null;
  });
}

/**
 * B0-792 — fact-only lookup PINNED to a specific resolved product (SKU), falling back to the
 * broader `fetchFactsForProductLineKey` line-wide merge only when no `productKey` was resolved.
 * See `fetchFactsForProductBatch` for the merge rule and why this matters.
 */
export async function fetchFactsForProduct(
  productLineKey: string,
  productKey: string | null,
  organism?: string,
): Promise<ProductLineFacts | null> {
  if (!productKey) {
    return fetchFactsForProductLineKey(productLineKey, organism);
  }
  const [result] = await fetchFactsForProductBatch([{ productLineKey, productKey }], organism);
  return result ?? null;
}

/**
 * B0-549 — batch counterpart to `fetchFactsForProductLineKey`: resolves every given
 * `product_line_key` to its entity id in ONE query, then reuses `fetchProductLineFacts` (already
 * batched) for the facts/efficacy rows in a second query — two round trips total regardless of
 * how many product lines are requested, instead of one `fetchFactsForProductLineKey` call (and its
 * own entity + facts round trips) per product. Keyed by `product_line_key` (not entity id) so
 * callers can look results up by the same key they passed in. Product lines that don't resolve to
 * an entity, or resolve but carry no verified facts, are simply absent from the returned map —
 * same "not on file" semantics as the single-key function, never a fabricated placeholder.
 *
 * B0-634 — the entity query now selects BOTH tiers (`product_line` + `product`) and partitions them
 * in memory, so a line whose regulated scalars live on the product tier is no longer read as null.
 * Still two round trips total. See `mergeProductTierFacts` for the agree-or-abstain merge rule.
 */
export async function fetchFactsForProductLineKeys(
  productLineKeys: string[],
  organism?: string,
): Promise<Map<string, ProductLineFacts>> {
  const uniqueKeys = [...new Set(productLineKeys.filter((k) => k.trim()))];
  const result = new Map<string, ProductLineFacts>();
  if (uniqueKeys.length === 0) {
    return result;
  }

  const rag = getSupabaseServiceRoleClient().schema('rag');
  // B0-634: widened from `.eq('entity_type', 'product_line')` to both tiers so product-tier
  // scalars are reachable; still ONE entity query no matter how many keys are passed.
  const { data: entities, error } = await rag
    .from('entity')
    .select('id, entity_type, product_line_key')
    .in('entity_type', ['product_line', 'product'])
    .in('product_line_key', uniqueKeys);

  if (error || !entities) {
    return result; // degrade gracefully — same posture as fetchProductLineFacts on error
  }

  const lineEntityIdByKey = new Map<string, string>();
  const productEntityIdsByKey = new Map<string, string[]>();
  for (const row of entities) {
    if (!row.product_line_key) continue;
    if (row.entity_type === 'product_line') {
      if (!lineEntityIdByKey.has(row.product_line_key)) {
        lineEntityIdByKey.set(row.product_line_key, row.id);
      }
      continue;
    }
    const list = productEntityIdsByKey.get(row.product_line_key) ?? [];
    list.push(row.id);
    productEntityIdsByKey.set(row.product_line_key, list);
  }

  if (lineEntityIdByKey.size === 0) {
    return result; // no product_line-tier entity to anchor on — unchanged "not on file" semantics
  }

  const entityIds = new Set<string>();
  for (const [key, lineEntityId] of lineEntityIdByKey) {
    entityIds.add(lineEntityId);
    for (const id of productEntityIdsByKey.get(key) ?? []) entityIds.add(id);
  }

  const rows = await fetchFactAndEfficacyRows([...entityIds]);
  if (!rows) {
    return result;
  }

  const efficacyByEntity = groupEfficacyByEntity(rows.efficacyRows);
  const factRowsByEntity = new Map<string, FactRow[]>();
  for (const row of rows.factRows) {
    const list = factRowsByEntity.get(row.entity_id) ?? [];
    list.push(row);
    factRowsByEntity.set(row.entity_id, list);
  }

  const needle = organism?.trim().toLowerCase();

  for (const [productLineKey, lineEntityId] of lineEntityIdByKey) {
    // Line tier is the base: only its `product_key IS NULL` row counts, exactly as before.
    const lineRow = (factRowsByEntity.get(lineEntityId) ?? []).find((row) => row.product_key == null);
    const lineEfficacy = efficacyByEntity.get(lineEntityId) ?? [];
    const base = lineRow
      ? factsFromRow(lineRow, lineEfficacy)
      : factsWithoutScalarRow(lineEntityId, lineEfficacy);

    const productEntityIds = productEntityIdsByKey.get(productLineKey) ?? [];
    const productTierRows = productEntityIds.flatMap((id) => factRowsByEntity.get(id) ?? []);
    const productTierEfficacy = productEntityIds.flatMap((id) => efficacyByEntity.get(id) ?? []);

    const facts = mergeProductTierFacts(base, productTierRows, productTierEfficacy);
    if (!hasAnyScalar(facts)) continue;
    result.set(productLineKey, filterEfficacyByOrganism(facts, needle));
  }

  return result;
}

function hasAnyScalar(f: ProductLineFacts): boolean {
  return (
    f.dilutionDisplay != null ||
    f.dilutionOzPerGal != null ||
    f.coverageSqFt != null ||
    f.chemistryClass != null ||
    f.productApplication != null ||
    f.epaRegistration != null ||
    f.contactTimeSeconds != null ||
    f.efficacy.length > 0
  );
}

/** B0-257: row confidence < 1.0 means the value is not a clean stamped fact -- surface it so an answer doesn't overstate certainty. */
function confidenceCaveat(confidence: number | null): string {
  return confidence != null && confidence < 1 ? ` (confidence ${confidence})` : '';
}

function renderFacts(name: string, f: ProductLineFacts): string | null {
  const lines: string[] = [`### ${name}`];
  const lineConfidenceNote = confidenceCaveat(f.confidence);

  if (f.dilutionDisplay || f.dilutionOzPerGal != null) {
    const oz = f.dilutionOzPerGal != null ? ` (${f.dilutionOzPerGal} oz/gal)` : '';
    lines.push(
      `- **Dilution:** ${f.dilutionDisplay ?? `${f.dilutionOzPerGal} oz/gal`}${f.dilutionDisplay && oz ? oz : ''}${lineConfidenceNote}`,
    );
  }
  if (f.coverageSqFt != null) lines.push(`- **Coverage:** ${f.coverageSqFt.toLocaleString()} sq ft/gal${lineConfidenceNote}`);
  if (f.chemistryClass) lines.push(`- **Chemistry:** ${f.chemistryClass}${lineConfidenceNote}`);
  if (f.productApplication) {
    // B0-263: application is classifier-derived (confidence < 1.0), never a stamped
    // fact like dilution/EPA reg -- render it as unverified so it isn't treated as
    // equally authoritative.
    const confidenceNote =
      f.productApplicationConfidence != null
        ? ` (classified, confidence ${f.productApplicationConfidence}, unverified)`
        : ' (classified, unverified)';
    lines.push(`- **Application:** ${f.productApplication}${confidenceNote}`);
  }
  if (f.epaRegistration) lines.push(`- **EPA reg:** ${f.epaRegistration}${lineConfidenceNote}`);
  if (f.contactTimeSeconds != null) lines.push(`- **Contact time:** ${f.contactTimeSeconds}s${lineConfidenceNote}`);

  if (f.efficacy.length > 0) {
    lines.push('- **Efficacy (verified kill claims):**');
    for (const e of f.efficacy) {
      const parts = [
        e.claimType ? `claim: ${e.claimType}` : null,
        e.dilutionOzPerGal != null ? `${e.dilutionOzPerGal} oz/gal` : null,
        e.contactTimeSeconds != null ? `${e.contactTimeSeconds}s contact` : null,
        e.epaRegistration ? `EPA ${e.epaRegistration}` : null,
      ].filter(Boolean);
      lines.push(
        `  - ${e.organism}${parts.length ? ` — ${parts.join(', ')}` : ''}${confidenceCaveat(e.confidence)}`,
      );
    }
  }

  return lines.length > 1 ? lines.join('\n') : null;
}

/**
 * Render a grounded, citation-safe facts block for the resolved entities. Returns null
 * when no entity has any structured fact. `titles` maps entity id → display name.
 */
export function buildFactsBlock(
  facts: Map<string, ProductLineFacts>,
  titles?: Map<string, string | null>,
): string | null {
  const sections: string[] = [];
  for (const f of facts.values()) {
    if (!hasAnyScalar(f)) continue;
    const name = titles?.get(f.entityId) || 'Product';
    const section = renderFacts(name, f);
    if (section) sections.push(section);
  }
  if (sections.length === 0) return null;
  return `## Verified Product Facts\n\nStructured, source-of-record facts for the resolved product line(s). Prefer these exact values for dilution, coverage, and kill claims.\n\n${sections.join('\n\n')}`;
}
