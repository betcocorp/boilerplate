import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "~/types/supabase.public";

let browserClient: SupabaseClient<Database> | undefined;

export function getSupabaseBrowserClient() {
  if (browserClient) {
    return browserClient;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Supabase environment variables are not configured.");
  }

  browserClient = createClient<Database>(supabaseUrl, supabaseAnonKey);

  return browserClient;
}
