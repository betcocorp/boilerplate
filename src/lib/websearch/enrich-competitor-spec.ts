import { z } from 'zod';

import { getOpenAIClient, resolveResponsesModel } from '~/lib/openai/client';
import { extractAssistantText } from '~/lib/openai/response-item-parsing';
import {
  competitorSpecSchema,
  extractCompetitorSpec,
} from '~/lib/websearch/extract-competitor-spec';

/**
 * B0-86 — LLM competitor-spec enrichment on top of the deterministic heuristic extractor.
 *
 * The heuristic (`extractCompetitorSpec`) runs first and is authoritative; an LLM pass then fills
 * the fields it left null and adds `productCategory`, `primaryUse`, `formFactor`, `keyClaims`. When
 * both produce a value for a base field, the **deterministic value wins**. Every field carries
 * provenance (`heuristic` | `llm` + source URL); anything neither can support stays `null` — never
 * hallucinated. Enrichment never throws: an LLM/parse failure degrades to heuristic-only.
 */

export const specProvenanceSchema = z
  .object({ source: z.enum(['heuristic', 'llm']), sourceUrl: z.string().nullable() })
  .nullable();
export type SpecProvenance = z.infer<typeof specProvenanceSchema>;

export const enrichedCompetitorSpecSchema = competitorSpecSchema.extend({
  productCategory: z.string().nullable(),
  primaryUse: z.string().nullable(),
  formFactor: z.string().nullable(),
  keyClaims: z.array(z.string()),
  provenance: z.object({
    chemistryClass: specProvenanceSchema,
    epaRegistration: specProvenanceSchema,
    contactTimeSeconds: specProvenanceSchema,
    dilutionOzPerGal: specProvenanceSchema,
    productCategory: specProvenanceSchema,
    primaryUse: specProvenanceSchema,
    formFactor: specProvenanceSchema,
    keyClaims: specProvenanceSchema,
  }),
});
export type EnrichedCompetitorSpec = z.infer<typeof enrichedCompetitorSpecSchema>;

/** What the LLM pass returns (all nullable; never trusted to fabricate). */
export const llmCompetitorSpecFillSchema = z.object({
  chemistryClass: z.string().nullable(),
  epaRegistration: z.string().nullable(),
  contactTimeSeconds: z.number().nullable(),
  dilutionOzPerGal: z.number().nullable(),
  productCategory: z.string().nullable(),
  primaryUse: z.string().nullable(),
  formFactor: z.string().nullable(),
  keyClaims: z.array(z.string()),
  sourceUrl: z.string().nullable(),
});
export type LlmCompetitorSpecFill = z.infer<typeof llmCompetitorSpecFillSchema>;

const EMPTY_LLM_FILL: LlmCompetitorSpecFill = {
  chemistryClass: null,
  epaRegistration: null,
  contactTimeSeconds: null,
  dilutionOzPerGal: null,
  productCategory: null,
  primaryUse: null,
  formFactor: null,
  keyClaims: [],
  sourceUrl: null,
};

export type EnrichCompetitorSpecInput = {
  text: string;
  /** Web sources the text came from; the first url is used as the heuristic's provenance URL. */
  sources?: Array<{ url: string; title?: string }>;
};

export type EnrichCompetitorSpecDeps = {
  runLlm: (input: EnrichCompetitorSpecInput) => Promise<LlmCompetitorSpecFill>;
};

const ENRICH_SYSTEM_PROMPT = `You extract a structured cleaning-product spec from web-search content about a competitor product.
Return ONLY facts explicitly supported by the provided content. Use null for anything not stated —
never guess, infer, or fabricate. Rules:
- chemistryClass: the active-ingredient class if stated (e.g. quat, peroxide, hypochlorite, phenolic, alcohol, acid), else null.
- epaRegistration: the EPA registration number exactly as written, else null.
- contactTimeSeconds: kill/contact time converted to seconds, else null.
- dilutionOzPerGal: dilution in ounces per gallon, else null.
- productCategory: the product category (e.g. "disinfectant", "floor stripper", "glass cleaner"), else null.
- primaryUse: one short phrase for its main use, else null.
- formFactor: e.g. "RTU liquid", "concentrate", "aerosol", "wipes", else null.
- keyClaims: up to 5 short verbatim efficacy/marketing claims found in the content (e.g. "kills 99.9% of germs"); empty array if none.
- sourceUrl: the single most authoritative source URL among the provided sources for these facts, else null.`;

/** Pure merge: heuristic wins for base fields; LLM fills the rest. Records per-field provenance. */
export function mergeCompetitorSpec(
  heuristic: z.infer<typeof competitorSpecSchema>,
  llm: LlmCompetitorSpecFill,
  primarySourceUrl: string | null,
): EnrichedCompetitorSpec {
  const heuristicProv = (value: unknown): SpecProvenance =>
    value == null ? null : { source: 'heuristic', sourceUrl: primarySourceUrl };
  const llmProv = (value: unknown): SpecProvenance =>
    value == null ? null : { source: 'llm', sourceUrl: llm.sourceUrl };

  // base field: deterministic wins, else llm
  const base = <T>(h: T | null, l: T | null): { value: T | null; prov: SpecProvenance } =>
    h != null
      ? { value: h, prov: heuristicProv(h) }
      : { value: l, prov: llmProv(l) };

  const chemistryClass = base(heuristic.chemistryClass, llm.chemistryClass);
  const epaRegistration = base(heuristic.epaRegistration, llm.epaRegistration);
  const contactTimeSeconds = base(heuristic.contactTimeSeconds, llm.contactTimeSeconds);
  const dilutionOzPerGal = base(heuristic.dilutionOzPerGal, llm.dilutionOzPerGal);

  return enrichedCompetitorSpecSchema.parse({
    chemistryClass: chemistryClass.value,
    epaRegistration: epaRegistration.value,
    contactTimeSeconds: contactTimeSeconds.value,
    dilutionOzPerGal: dilutionOzPerGal.value,
    productCategory: llm.productCategory,
    primaryUse: llm.primaryUse,
    formFactor: llm.formFactor,
    keyClaims: llm.keyClaims,
    provenance: {
      chemistryClass: chemistryClass.prov,
      epaRegistration: epaRegistration.prov,
      contactTimeSeconds: contactTimeSeconds.prov,
      dilutionOzPerGal: dilutionOzPerGal.prov,
      productCategory: llmProv(llm.productCategory),
      primaryUse: llmProv(llm.primaryUse),
      formFactor: llmProv(llm.formFactor),
      keyClaims: llm.keyClaims.length > 0 ? { source: 'llm', sourceUrl: llm.sourceUrl } : null,
    },
  });
}

const ENRICH_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    chemistryClass: { type: ['string', 'null'] },
    epaRegistration: { type: ['string', 'null'] },
    contactTimeSeconds: { type: ['number', 'null'] },
    dilutionOzPerGal: { type: ['number', 'null'] },
    productCategory: { type: ['string', 'null'] },
    primaryUse: { type: ['string', 'null'] },
    formFactor: { type: ['string', 'null'] },
    keyClaims: { type: 'array', items: { type: 'string' } },
    sourceUrl: { type: ['string', 'null'] },
  },
  required: [
    'chemistryClass',
    'epaRegistration',
    'contactTimeSeconds',
    'dilutionOzPerGal',
    'productCategory',
    'primaryUse',
    'formFactor',
    'keyClaims',
    'sourceUrl',
  ],
} as const;

async function defaultRunLlm(input: EnrichCompetitorSpecInput): Promise<LlmCompetitorSpecFill> {
  try {
    const client = getOpenAIClient();
    const res = await client.responses.create({
      model: process.env.XREF_SPEC_ENRICH_MODEL?.trim() || resolveResponsesModel('preview'),
      instructions: ENRICH_SYSTEM_PROMPT,
      input: [
        {
          role: 'user',
          content: JSON.stringify({ content: input.text, sources: input.sources ?? [] }),
          type: 'message',
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'competitor_spec_fill',
          strict: true,
          schema: ENRICH_JSON_SCHEMA,
        },
      },
      store: false,
      stream: false,
      temperature: 0,
    });
    return llmCompetitorSpecFillSchema.parse(JSON.parse(extractAssistantText(res)));
  } catch {
    // degrade to heuristic-only rather than fail the whole recommendation
    return EMPTY_LLM_FILL;
  }
}

export async function enrichCompetitorSpec(
  input: EnrichCompetitorSpecInput,
  deps: EnrichCompetitorSpecDeps = { runLlm: defaultRunLlm },
): Promise<EnrichedCompetitorSpec> {
  const heuristic = extractCompetitorSpec(input.text);
  const llm = await deps.runLlm(input);
  const primarySourceUrl = input.sources?.[0]?.url ?? null;
  return mergeCompetitorSpec(heuristic, llm, primarySourceUrl);
}
