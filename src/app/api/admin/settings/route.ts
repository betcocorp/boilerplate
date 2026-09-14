import { getServerSession } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { authOptions } from '~/lib/auth';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { gateRoute } from '~/lib/permissions/route-gate';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * `{ key, value }` writes a value; `{ key, reset: true }` clears it so the row falls back to its
 * `default_value` (B0-992). A reset on a row with no default is refused rather than leaving the
 * reader with nothing.
 */
const updateSettingSchema = z.union([
  z.object({ key: z.string(), value: z.string() }),
  z.object({ key: z.string(), reset: z.literal(true) }),
]);

/**
 * GET /api/admin/settings — fetch all settings
 */
export async function GET() {
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .from('settings')
      .select('key, value, value_type, description, allowed_values, default_value, ui_group')
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
    const parsed = updateSettingSchema.parse(body);
    const { key } = parsed;

    const supabase = getSupabaseServiceRoleClient();

    // Fetch the setting to validate value_type
    const { data: setting, error: fetchError } = await supabase
      .from('settings')
      .select('value_type, allowed_values, default_value')
      .eq('key', key)
      .single();

    if (fetchError || !setting) {
      return NextResponse.json(
        { error: `Setting ${key} not found` },
        { status: 404 },
      );
    }

    // B0-992 — reset: clear the stored value so the reader falls back to default_value.
    if ('reset' in parsed) {
      if (setting.default_value === null) {
        return NextResponse.json(
          { error: `Setting ${key} has no default to reset to` },
          { status: 400 },
        );
      }
      const { error: resetError } = await supabase
        .from('settings')
        .update({ value: null, updated_at: new Date().toISOString() })
        .eq('key', key);
      if (resetError) {
        console.error('Error resetting setting:', resetError);
        return NextResponse.json({ error: 'Failed to reset setting' }, { status: 500 });
      }
      return NextResponse.json({ success: true, key, value: null, reset: true });
    }

    const { value } = parsed;

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
