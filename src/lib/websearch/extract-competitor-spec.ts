import { z } from 'zod';

/** Normalized competitor product spec extracted from free-text search content (WEB-3). */
export const competitorSpecSchema = z.object({
  chemistryClass: z.string().nullable(),
  epaRegistration: z.string().nullable(),
  contactTimeSeconds: z.number().nullable(),
  dilutionOzPerGal: z.number().nullable(),
});
export type CompetitorSpec = z.infer<typeof competitorSpecSchema>;

const CHEMISTRY_PATTERNS: Array<[RegExp, string]> = [
  [/\bquat(?:ernary)?\b/i, 'quat'],
  [/\b(?:hydrogen\s+)?peroxide\b/i, 'peroxide'],
  [/\b(?:sodium\s+)?hypochlorite\b|\bbleach\b/i, 'hypochlorite'],
  [/\bphenolic\b|\bphenol\b/i, 'phenolic'],
  [/\bisopropyl\b|\bethanol\b|\balcohol\b/i, 'alcohol'],
  [/\bcitric\s+acid\b/i, 'acid'],
];

/**
 * Deterministic (no-LLM, no-network) heuristic extractor. Feeds REC-1 competitor grounding.
 * Returns nulls for anything not confidently found — callers decide whether to fall back.
 */
export function extractCompetitorSpec(text: string): CompetitorSpec {
  const source = text ?? '';

  let chemistryClass: string | null = null;
  for (const [pattern, label] of CHEMISTRY_PATTERNS) {
    if (pattern.test(source)) {
      chemistryClass = label;
      break;
    }
  }

  const epaMatch = source.match(
    /EPA\s*Reg(?:istration)?\.?\s*(?:No\.?|#)?\s*([0-9]{2,7}-[0-9]{1,5}(?:-[0-9]{1,5})?)/i,
  );

  const contactMatch = source.match(
    /(\d+(?:\.\d+)?)\s*-?\s*(second|sec|minute|min)s?\b/i,
  );
  let contactTimeSeconds: number | null = null;
  if (contactMatch) {
    const value = Number(contactMatch[1]);
    contactTimeSeconds = /min/i.test(contactMatch[2] ?? '') ? value * 60 : value;
  }

  const dilutionMatch = source.match(
    /(\d+(?:\.\d+)?)\s*(?:oz|ounce)s?\.?\s*(?:\/|per)\s*gal/i,
  );

  return {
    chemistryClass,
    epaRegistration: epaMatch?.[1] ?? null,
    contactTimeSeconds,
    dilutionOzPerGal: dilutionMatch ? Number(dilutionMatch[1]) : null,
  };
}
