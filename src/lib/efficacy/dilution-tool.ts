// Deterministic efficacy/dilution tool for orchestrator integration (B0-288)
// Provides pure function for dilution ratio lookups from Supabase RAG, safe for caching and reuse

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import type { Database as RagDatabase } from '~/types/supabase.rag';

// Zod schema for dilution request
export const dilutionToolRequestSchema = z.object({
  product_key: z.string().min(1),
  use_case: z.enum(['general_cleaning', 'disinfection', 'floor_care', 'pressure_wash']),
  surface_type: z.enum(['tile', 'linoleum', 'concrete', 'carpet', 'stainless_steel']).optional(),
  dilution_unit: z.enum(['oz_per_gallon', 'ml_per_liter', 'ppm']).default('oz_per_gallon'),
});

export type DilutionToolRequest = z.infer<typeof dilutionToolRequestSchema>;

// Zod schema for dilution response
export const dilutionToolResponseSchema = z.object({
  product_key: z.string(),
  use_case: z.string(),
  dilution_ratio: z.number().nonnegative(),
  dilution_unit: z.enum(['oz_per_gallon', 'ml_per_liter', 'ppm']),
  contact_time_minutes: z.number().int().positive().optional(),
  log_reduction: z.number().optional(),
  rtu_ready: z.boolean().default(false).optional(),
  source: z.enum(['label_data', 'sds', 'product_fact', 'user_input', 'inferred']),
  confidence: z.number().min(0).max(1).default(1),
  notes: z.string().optional(),
});

export type DilutionToolResponse = z.infer<typeof dilutionToolResponseSchema>;

/**
 * Initialize Supabase client for RAG queries
 */
function getRagClient() {
  return createClient<RagDatabase>(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  );
}

/**
 * Fetch product line key from product key (legacy tier lookup)
 */
async function resolveProductLineKey(product_key: string): Promise<string | null> {
  const client = getRagClient();

  // Try to find the product entity and get its product_line_key
  const { data } = await client
    .from('entity')
    .select('product_line_key, metadata')
    .eq('metadata->>product_key', product_key)
    .eq('entity_type', 'product')
    .maybeSingle();

  return data?.product_line_key || null;
}

/**
 * Fetch dilution data from rag.product_line_fact
 */
async function fetchProductLineFact(
  product_line_key: string
): Promise<{
  dilution_oz_per_gal: number | null;
  dilution_display: string | null;
  confidence: number;
} | null> {
  const client = getRagClient();

  const { data } = await client
    .from('product_line_fact')
    .select('dilution_oz_per_gal, dilution_display, confidence')
    .eq('entity_id', product_line_key)
    .is('product_key', null) // Line-level fact only
    .order('confidence', { ascending: false })
    .maybeSingle();

  return data || null;
}

/**
 * Deterministic efficacy/dilution lookup
 * Queries Supabase RAG tables; same input always returns same output
 * Suitable for caching, tool calling, and orchestrator integration
 */
export async function getDilutionRatio(
  request: DilutionToolRequest
): Promise<DilutionToolResponse> {
  const { product_key, use_case, dilution_unit } = dilutionToolRequestSchema.parse(request);

  try {
    // Resolve product_line_key from product_key
    const product_line_key = await resolveProductLineKey(product_key);
    if (!product_line_key) {
      return {
        product_key,
        use_case,
        dilution_ratio: 0,
        dilution_unit,
        source: 'inferred',
        confidence: 0.1,
        notes: `Product ${product_key} not found in product registry.`,
      };
    }

    // Fetch product line facts
    const factData = await fetchProductLineFact(product_line_key);

    // Return data if found
    if (factData && factData.dilution_oz_per_gal !== null) {
      const baseDilution = factData.dilution_oz_per_gal;

      // Convert to requested unit
      let finalRatio = baseDilution;
      const finalUnit = dilution_unit;

      if (dilution_unit === 'ml_per_liter' && baseDilution > 0) {
        // oz_per_gallon → ml_per_liter: multiply by ~29.5 (ml/oz) / 3.78 (L/gal) ≈ 7.8
        finalRatio = baseDilution * 7.8;
      } else if (dilution_unit === 'ppm' && baseDilution > 0) {
        // oz_per_gallon → ppm: roughly 7.5 oz/gal ≈ 1000 ppm
        finalRatio = (baseDilution / 7.5) * 1000;
      }

      // Determine if RTU
      const rtu_ready = baseDilution === 0;

      return {
        product_key,
        use_case,
        dilution_ratio: finalRatio,
        dilution_unit: finalUnit,
        rtu_ready: rtu_ready ? true : undefined,
        contact_time_minutes: use_case === 'disinfection' ? 10 : 5,
        source: 'product_fact',
        confidence: Math.min(factData.confidence || 0.8, 1),
        notes: rtu_ready ? 'Ready-to-use; no dilution required.' : undefined,
      };
    }

    // Fallback: no dilution data found
    return {
      product_key,
      use_case,
      dilution_ratio: 0,
      dilution_unit,
      source: 'inferred',
      confidence: 0.2,
      notes: `No dilution data found for ${product_key}; consult product label or SDS.`,
    };
  } catch (error) {
    console.error('getDilutionRatio error:', error);
    return {
      product_key,
      use_case,
      dilution_ratio: 0,
      dilution_unit,
      source: 'inferred',
      confidence: 0,
      notes: 'Error querying dilution data; consult product documentation.',
    };
  }
}

/**
 * Batch dilution lookup (for multiple use cases or surfaces)
 */
export async function getDilutionRatioBatch(
  requests: DilutionToolRequest[]
): Promise<DilutionToolResponse[]> {
  return Promise.all(requests.map((req) => getDilutionRatio(req)));
}
