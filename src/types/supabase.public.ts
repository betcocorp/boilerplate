/**
 * Placeholder `Database` type — regenerate this against your real schema once you have one:
 *
 *   pnpm supabase gen types typescript --project-id <ref> --schema public > src/types/supabase.public.ts
 *
 * `Json` is kept because a couple of client helpers type against it directly.
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
};
