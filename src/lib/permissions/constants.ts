/**
 * Permission identifiers (must match `public.permission.selector` values).
 * Use for UI checks and requirePermission() in API routes.
 *
 * Deny-by-default: a surface with no selector is unconditionally visible, and every selector
 * below is granted to the `it-admin` permission group only (see the seed migration). Add a
 * selector here AND a `public.permission` row (plus a `group_permission` grant) together.
 */
export const PERMISSIONS = {
  ADMIN_CARD_PERMISSIONS: 'admin.card.permissions',
  NAVIGATION_SIDEBAR_USER_ANALYTICS: 'navigation.sidebar.user.analytics',
} as const;

export type PermissionId =
  | (typeof PERMISSIONS)[keyof typeof PERMISSIONS]
  | string;
