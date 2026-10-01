import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiToken } from '~/lib/api/client-auth';
import {
  getDilutionRatio,
  getDilutionRatioBatch,
  dilutionToolRequestSchema,
  dilutionToolResponseSchema,
} from '~/lib/efficacy/dilution-tool';
import { z } from 'zod';

// Request schema for single or batch dilution lookups
const efficacyRequestSchema = z.union([
  z.object({
    mode: z.literal('single').optional(),
    product_key: z.string().min(1),
    use_case: z.enum(['general_cleaning', 'disinfection', 'floor_care', 'pressure_wash']),
    surface_type: z
      .enum(['tile', 'linoleum', 'concrete', 'carpet', 'stainless_steel'])
      .optional(),
    dilution_unit: z.enum(['oz_per_gallon', 'ml_per_liter', 'ppm']).default('oz_per_gallon'),
  }),
  z.object({
    mode: z.literal('batch'),
    requests: z.array(dilutionToolRequestSchema),
  }),
]);

export async function POST(request: NextRequest) {
  // Authenticate API token
  const authResult = await authenticateApiToken(request);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  try {
    const body = await request.json();
    const parsed = efficacyRequestSchema.parse(body);

    let result;

    if ('mode' in parsed && parsed.mode === 'batch') {
      result = await getDilutionRatioBatch(parsed.requests);
    } else {
      const singleRequest = {
        product_key: parsed.product_key,
        use_case: parsed.use_case,
        surface_type: parsed.surface_type,
        dilution_unit: parsed.dilution_unit,
      };
      result = await getDilutionRatio(singleRequest);
    }

    // Validate response schema
    const validatedResult = Array.isArray(result)
      ? z.array(dilutionToolResponseSchema).parse(result)
      : dilutionToolResponseSchema.parse(result);

    return NextResponse.json({
      success: true,
      data: validatedResult,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: 'Invalid request',
          issues: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Internal server error', message: String(error) },
      { status: 500 }
    );
  }
}

// GET for reference/documentation
export function GET(request: NextRequest) {
  return NextResponse.json({
    tool: 'efficacy_dilution_lookup',
    description: 'Deterministic lookup of dilution ratios for Betco products',
    endpoints: {
      POST: {
        single: {
          description: 'Get dilution ratio for a single product + use case',
          example: {
            product_key: 'betco_fastdraw',
            use_case: 'disinfection',
            dilution_unit: 'oz_per_gallon',
          },
        },
        batch: {
          description: 'Get dilution ratios for multiple product/use case combinations',
          example: {
            mode: 'batch',
            requests: [
              {
                product_key: 'betco_fastdraw',
                use_case: 'general_cleaning',
              },
              {
                product_key: '1950_citrus_fresh',
                use_case: 'disinfection',
              },
            ],
          },
        },
      },
    },
    auth: 'Bearer token (per-client API key required)',
  });
}
