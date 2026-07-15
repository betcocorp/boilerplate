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
};

export type ProductLineFacts = {
  entityId: string;
  dilutionOzPerGal: number | null;
  dilutionDisplay: string | null;
  coverageSqFt: number | null;
  chemistryClass: string | null;
  productApplication: string | null;
  epaRegistration: string | null;
  contactTimeSeconds: number | null;
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
        'entity_id, dilution_oz_per_gal, dilution_display, coverage_sq_ft, chemistry_class, product_application, epa_registration, contact_time_seconds',
      )
      .in('entity_id', unique)
      .is('product_key', null),
    rag
      .from('product_efficacy')
      .select(
        'entity_id, organism, claim_type, dilution_oz_per_gal, contact_time_seconds, epa_registration',
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
      epaRegistration: row.epa_registration,
      contactTimeSeconds: row.contact_time_seconds,
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
        epaRegistration: null,
        contactTimeSeconds: null,
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

function renderFacts(name: string, f: ProductLineFacts): string | null {
  const lines: string[] = [`### ${name}`];

  if (f.dilutionDisplay || f.dilutionOzPerGal != null) {
    const oz = f.dilutionOzPerGal != null ? ` (${f.dilutionOzPerGal} oz/gal)` : '';
    lines.push(`- **Dilution:** ${f.dilutionDisplay ?? `${f.dilutionOzPerGal} oz/gal`}${f.dilutionDisplay && oz ? oz : ''}`);
  }
  if (f.coverageSqFt != null) lines.push(`- **Coverage:** ${f.coverageSqFt.toLocaleString()} sq ft/gal`);
  if (f.chemistryClass) lines.push(`- **Chemistry:** ${f.chemistryClass}`);
  if (f.productApplication) lines.push(`- **Application:** ${f.productApplication}`);
  if (f.epaRegistration) lines.push(`- **EPA reg:** ${f.epaRegistration}`);
  if (f.contactTimeSeconds != null) lines.push(`- **Contact time:** ${f.contactTimeSeconds}s`);

  if (f.efficacy.length > 0) {
    lines.push('- **Efficacy (verified kill claims):**');
    for (const e of f.efficacy) {
      const parts = [
        e.claimType ? `claim: ${e.claimType}` : null,
        e.dilutionOzPerGal != null ? `${e.dilutionOzPerGal} oz/gal` : null,
        e.contactTimeSeconds != null ? `${e.contactTimeSeconds}s contact` : null,
        e.epaRegistration ? `EPA ${e.epaRegistration}` : null,
      ].filter(Boolean);
      lines.push(`  - ${e.organism}${parts.length ? ` — ${parts.join(', ')}` : ''}`);
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
