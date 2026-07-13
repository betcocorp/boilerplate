import { lookupCrossReference } from '~/lib/tools/cross-reference-lookup';
import {
  extractCompetitorSpec,
  type CompetitorSpec,
} from '~/lib/websearch/extract-competitor-spec';
import { WebSearchService } from '~/lib/websearch/web-search-service';

/**
 * REC-1 — Ground a competitor product to a structured spec BEFORE any Betco retrieval.
 *
 * Source order: internal cross-reference cache → web fallback (WEB-1/WEB-3) → fail loudly.
 * The bar for "grounded" is a resolved `chemistryClass`; anything less returns an explicit
 * `unresolved` state. This service never fabricates a spec, SKU, or claim — the BNC-15 root
 * cause was the system falling through to prose similarity and inventing a match.
 *
 * Wiring this into the live agent tool loop (so the model calls it automatically) is the
 * surfacing step tracked separately (B0-79 / WEB-6): it touches the shared `productSupportTools`
 * and spends the web-search provider budget, so it stays out of the default production path here.
 */

export type CompetitorGroundingInput = {
  brand?: string | null;
  productName: string;
};

export type GroundingSource = 'internal' | 'web';

export type CompetitorGrounding =
  | {
      status: 'grounded';
      source: GroundingSource;
      brand: string | null;
      productName: string;
      spec: CompetitorSpec;
      evidenceText: string;
      citations: string[];
    }
  | {
      status: 'unresolved';
      brand: string | null;
      productName: string;
      reason: string;
      attempted: GroundingSource[];
    };

type InternalEvidence = { text: string };
type WebEvidence = { text: string; citations: string[] };

export type CompetitorGroundingDeps = {
  /** Resolve descriptive text for the competitor product from internal data (legacy cross-reference). */
  lookupInternal: (input: {
    brand: string | null;
    productName: string;
  }) => Promise<InternalEvidence | null>;
  /** Resolve descriptive text + citations for the competitor product from the web. */
  fetchWeb: (query: string) => Promise<WebEvidence | null>;
};

/** Build the free-text blob the deterministic extractor parses (product + brand + evidence). */
function joinEvidence(
  productName: string,
  brand: string | null,
  text: string,
): string {
  return [productName, brand, text].filter(Boolean).join('. ');
}

function buildGroundingQuery(input: {
  brand: string | null;
  productName: string;
}): string {
  return [
    input.brand,
    input.productName,
    'disinfectant SDS EPA registration contact time dilution',
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
}

/** Run a source and degrade to null on any error so grounding can fall through / fail cleanly. */
async function tryStep<T>(fn: () => Promise<T | null>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

async function defaultLookupInternal(input: {
  brand: string | null;
  productName: string;
}): Promise<InternalEvidence | null> {
  const result = await lookupCrossReference({
    brand: input.brand ?? '',
    productName: input.productName,
    maxResults: 3,
  });
  const text = result.matches?.[0]?.competitorProductName?.trim();
  return text ? { text } : null;
}

async function defaultFetchWeb(query: string): Promise<WebEvidence | null> {
  const response = await new WebSearchService().search({
    query,
    maxResults: 5,
  });
  const parts: string[] = [];
  const citations: string[] = [];
  if (response.answer) {
    parts.push(response.answer);
  }
  for (const result of response.results) {
    const line = [result.title, result.snippet, result.rawContent]
      .filter(Boolean)
      .join(' — ');
    if (line) {
      parts.push(line);
    }
    citations.push(result.url);
  }
  const text = parts.join('\n').trim();
  return text ? { text, citations } : null;
}

export async function groundCompetitorProduct(
  input: CompetitorGroundingInput,
  deps?: Partial<CompetitorGroundingDeps>,
): Promise<CompetitorGrounding> {
  const brand = input.brand?.trim() ? input.brand.trim() : null;
  const productName = input.productName.trim();
  const attempted: GroundingSource[] = [];

  if (!productName) {
    return {
      status: 'unresolved',
      brand,
      productName: input.productName,
      reason: 'No competitor product name provided.',
      attempted,
    };
  }

  const lookupInternal = deps?.lookupInternal ?? defaultLookupInternal;
  const fetchWeb = deps?.fetchWeb ?? defaultFetchWeb;

  attempted.push('internal');
  const internal = await tryStep(() => lookupInternal({ brand, productName }));
  if (internal?.text) {
    const spec = extractCompetitorSpec(
      joinEvidence(productName, brand, internal.text),
    );
    if (spec.chemistryClass) {
      return {
        status: 'grounded',
        source: 'internal',
        brand,
        productName,
        spec,
        evidenceText: internal.text,
        citations: [],
      };
    }
  }

  attempted.push('web');
  const web = await tryStep(() =>
    fetchWeb(buildGroundingQuery({ brand, productName })),
  );
  if (web?.text) {
    const spec = extractCompetitorSpec(
      joinEvidence(productName, brand, web.text),
    );
    if (spec.chemistryClass) {
      return {
        status: 'grounded',
        source: 'web',
        brand,
        productName,
        spec,
        evidenceText: web.text,
        citations: web.citations,
      };
    }
  }

  return {
    status: 'unresolved',
    brand,
    productName,
    reason:
      'Could not resolve the competitor product to a chemistry class from internal cross-reference or web sources; refusing to guess.',
    attempted,
  };
}
