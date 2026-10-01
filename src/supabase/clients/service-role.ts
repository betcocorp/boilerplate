import { createClient } from "@supabase/supabase-js";

import type { Database as LegacyDatabase } from "~/types/supabase.legacy";
import type { Database as PublicDatabase } from "~/types/supabase.public";
import type { Database as RagDatabase } from "~/types/supabase.rag";

type ServiceRoleDatabase = PublicDatabase & LegacyDatabase & RagDatabase;

export function getSupabaseServiceRoleClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error(
      "Supabase service role environment variables are not configured.",
    );
  }

  return createClient<ServiceRoleDatabase>(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
