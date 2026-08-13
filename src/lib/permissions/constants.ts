/**
 * Permission identifiers (must match `public.permission.selector` values).
 * Use for UI checks and requirePermission() in API routes.
 *
 * The `navigation.sidebar.*` selectors mirror the ten admin surfaces under
 * `src/app/(authenticated)/admin/` (see `~/components/admin/AdminSidebarNav`).
 */
export const PERMISSIONS = {
  DASHBOARD_PERMISSIONS_CARD: 'dashboard.permissions.card',
  SIDEBAR_NAVIGATION_INGESTION: 'sidebar.navigation.ingestion',
  SIDEBAR_NAVIGATION_API_PERMISSIONS: 'sidebar.navigation.api_permissions',
} as const;

export type PermissionId =
  | (typeof PERMISSIONS)[keyof typeof PERMISSIONS]
  | string;
