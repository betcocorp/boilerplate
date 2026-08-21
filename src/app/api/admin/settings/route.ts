import { getServerSession } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { authOptions } from '~/lib/auth';
import { gateRoute } from '~/lib/permissions/route-gate';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { getSupabaseServerClient } from '~/supabase/clients/server';

const updateSettingSchema = z.object({
  key: z.string(),
  value: z.string(),
});

/**
 * GET /api/admin/settings — fetch all settings
 */
export async function GET() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = getSupabaseServerClient() as any;
    const { data, error } = await supabase
      .from('settings')
      .select('key, value, value_type, description, allowed_values')
      .order('key');

    if (error) {
      console.error('Error fetching settings:', error);
      return NextResponse.json(
        { error: 'Failed to fetch settings' },
        { status: 500 },
      );
    }

    return NextResponse.json({ settings: data });
  } catch (err) {
    console.error('Error in GET /api/admin/settings:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

/**
 * POST /api/admin/settings — update a single setting (requires admin permission)
 */
export async function POST(request: NextRequest) {
  try {
    // Check session
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 },
      );
    }

    // Check permission
    const denied = await gateRoute(
      PERMISSIONS.NAVIGATION_SIDEBAR_USER_SETTINGS,
      'POST /api/admin/settings',
    );
    if (denied) return denied;

    const body = await request.json();
    const { key, value } = updateSettingSchema.parse(body);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = getSupabaseServerClient() as any;

    // Fetch the setting to validate value_type
    const { data: setting, error: fetchError } = await supabase
      .from('settings')
      .select('value_type, allowed_values')
      .eq('key', key)
      .single();

    if (fetchError || !setting) {
      return NextResponse.json(
        { error: `Setting ${key} not found` },
        { status: 404 },
      );
    }

    // Validate the value based on type
    if (setting.value_type === 'boolean') {
      if (!['true', 'false'].includes(value.toLowerCase())) {
        return NextResponse.json(
          { error: 'Invalid boolean value' },
          { status: 400 },
        );
      }
    } else if (setting.value_type === 'number') {
      if (isNaN(Number(value))) {
        return NextResponse.json(
          { error: 'Invalid number value' },
          { status: 400 },
        );
      }
    } else if (
      setting.value_type === 'string' &&
      setting.allowed_values &&
      setting.allowed_values.length > 0
    ) {
      if (!setting.allowed_values.includes(value)) {
        return NextResponse.json(
          {
            error: `Invalid value. Allowed values: ${setting.allowed_values.join(', ')}`,
          },
          { status: 400 },
        );
      }
    }

    // Update the setting
    const { error: updateError } = await supabase
      .from('settings')
      .update({
        value,
        updated_at: new Date().toISOString(),
      })
      .eq('key', key);

    if (updateError) {
      console.error('Error updating setting:', updateError);
      return NextResponse.json(
        { error: 'Failed to update setting' },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true, key, value });
  } catch (err) {
    console.error('Error in POST /api/admin/settings:', err);
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request', issues: err.issues },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
