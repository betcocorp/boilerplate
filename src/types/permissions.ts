/**
 * Permission row shapes for the ported permissions system (consolidates c360's
 * `types/permission.ts` + `types/permission_group.ts`).
 *
 * Keys stay UPPERCASE to match the wire shape the c360 permissions system uses, so the
 * ported helpers stay drop-in compatible; the repository maps Supabase's lowercase
 * `public.permission` / `public.permission_group` columns onto these.
 */

/**
 * A row of `public.permission`.
 */
export interface Permission {
  PERMISSION_ID: string;
  SELECTOR: string;
  DESCRIPTION?: string | null;
  CREATED_AT: string;
  UPDATED_AT: string;
  DELETED_AT?: string | null;
}

/**
 * A row of `public.permission_group`.
 */
export interface PermissionGroup {
  PERMISSION_GROUP_ID: string;
  SELECTOR: string;
  DESCRIPTION?: string | null;
  START_AT?: string | null;
  END_AT?: string | null;
  CREATED_AT: string;
  UPDATED_AT: string;
  DELETED_AT?: string | null;
}
