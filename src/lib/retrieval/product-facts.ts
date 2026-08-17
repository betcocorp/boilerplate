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

/** Fetch line-level facts + efficacy rows for a set of entity ids. Degrades to an empty map on error. */
export async function fetchProductLineFacts(
  entityIds: string[],
): Promise<Map<string, ProductLineFacts>> {
  const unique = [...new Set(entityIds.filter(Boolean))];
  const map = new Map<string, ProductLineFacts>();
  if (unique.length === 0) {
    return map;
  }

  const rag = getSupabaseServiceRoleClient().schema('rag');
  const [factsRes, efficacyRes] = await Promise.all([
    rag
      .from('product_line_fact')
      .select(
        'entity_id, dilution_oz_per_gal, dilution_display, coverage_sq_ft, chemistry_class, product_application, product_application_confidence, epa_registration, contact_time_seconds, confidence',
      )
      .in('entity_id', unique)
      .is('product_key', null),
    rag
      .from('product_efficacy')
      .select(
        'entity_id, organism, claim_type, dilution_oz_per_gal, contact_time_seconds, epa_registration, confidence',
      )
      .in('entity_id', unique),
  ]);

  if (factsRes.error || efficacyRes.error) {
    return map; // grounding degrades gracefully — never block retrieval on a facts miss
  }

  const efficacyByEntity = new Map<string, ProductEfficacyFact[]>();
  for (const row of efficacyRes.data ?? []) {
    const list = efficacyByEntity.get(row.entity_id) ?? [];
    list.push({
      organism: row.organism,
      claimType: row.claim_type,
      dilutionOzPerGal: row.dilution_oz_per_gal,
      contactTimeSeconds: row.contact_time_seconds,
      epaRegistration: row.epa_registration,
      confidence: row.confidence,
    });
    efficacyByEntity.set(row.entity_id, list);
  }

  for (const row of factsRes.data ?? []) {
    map.set(row.entity_id, {
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
      efficacy: efficacyByEntity.get(row.entity_id) ?? [],
    });
  }

  // Entities with efficacy rows but no scalar fact row still get an entry.
  for (const [entityId, efficacy] of efficacyByEntity) {
    if (!map.has(entityId)) {
      map.set(entityId, {
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
      });
    }
  }

  return map;
}

/**
 * Fact-only lookup for a single product line resolved by product_line_key.
 * Returns null when the line can't be resolved or has no verified facts.
 * `organism` optionally filters the efficacy rows (case-insensitive contains).
 */
export async function fetchFactsForProductLineKey(
  productLineKey: string,
  organism?: string,
): Promise<ProductLineFacts | null> {
  const rag = getSupabaseServiceRoleClient().schema('rag');
  const { data: entity } = await rag
    .from('entity')
    .select('id')
    .eq('entity_type', 'product_line')
    .eq('product_line_key', productLineKey)
    .limit(1)
    .maybeSingle();

  if (!entity?.id) return null;

  const facts = (await fetchProductLineFacts([entity.id])).get(entity.id);
  if (!facts || !hasAnyScalar(facts)) return null;

  const needle = organism?.trim().toLowerCase();
  if (needle) {
    return { ...facts, efficacy: facts.efficacy.filter((e) => e.organism.toLowerCase().includes(needle)) };
  }
  return facts;
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
  const { data: entities, error } = await rag
    .from('entity')
    .select('id, product_line_key')
    .eq('entity_type', 'product_line')
    .in('product_line_key', uniqueKeys);

  if (error || !entities) {
    return result; // degrade gracefully — same posture as fetchProductLineFacts on error
  }

  const entityIdByProductLineKey = new Map<string, string>();
  for (const row of entities) {
    if (row.product_line_key && !entityIdByProductLineKey.has(row.product_line_key)) {
      entityIdByProductLineKey.set(row.product_line_key, row.id);
    }
  }

  const factsByEntityId = await fetchProductLineFacts([...entityIdByProductLineKey.values()]);
  const needle = organism?.trim().toLowerCase();

  for (const [productLineKey, entityId] of entityIdByProductLineKey) {
    const facts = factsByEntityId.get(entityId);
    if (!facts || !hasAnyScalar(facts)) continue;
    result.set(
      productLineKey,
      needle
        ? { ...facts, efficacy: facts.efficacy.filter((e) => e.organism.toLowerCase().includes(needle)) }
        : facts,
    );
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
