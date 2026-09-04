/**
 * Permission identifiers (must match `public.permission.selector` values).
 * Use for UI checks and requirePermission() in API routes.
 *
 * The `navigation.sidebar.*` selectors mirror the admin surfaces under
 * `src/app/(authenticated)/admin/` (see `~/components/admin/AdminSidebarNav*`,
 * `~/components/admin/AdminAccountMenu.tsx`). Deny-by-default (B0-560): an
 * admin surface with no selector here is unconditionally visible; every
 * selector below is granted to the `it-admin` permission group only.
 */
export const PERMISSIONS = {
  ADMIN_CARD_PERMISSIONS: 'admin.card.permissions',

  BEX_CHAT_USE: 'bex.chat.use',
  BEX_CHAT_VIEW_ALL: 'bex.chat.view-all',

  NAVIGATION_SIDEBAR_TESTS: 'navigation.sidebar.tests',
  NAVIGATION_SIDEBAR_OBSERVABILITY: 'navigation.sidebar.observability',
  NAVIGATION_SIDEBAR_TOOLS: 'navigation.sidebar.tools',
  NAVIGATION_SIDEBAR_PRODUCTS: 'navigation.sidebar.products',
  NAVIGATION_SIDEBAR_INGESTION_PRODUCTS:
    'navigation.sidebar.ingestion.products',
  NAVIGATION_SIDEBAR_SDS: 'navigation.sidebar.sds',
  NAVIGATION_SIDEBAR_COMPARE: 'navigation.sidebar.compare',
  NAVIGATION_SIDEBAR_EFFICACY: 'navigation.sidebar.efficacy',
  NAVIGATION_SIDEBAR_KNOWLEDGE: 'navigation.sidebar.knowledge',
  NAVIGATION_SIDEBAR_LABELS: 'navigation.sidebar.labels',
  NAVIGATION_SIDEBAR_USER_ANALYTICS: 'navigation.sidebar.user.analytics',
  NAVIGATION_SIDEBAR_USER_API_ACCESS: 'navigation.sidebar.user.api_access',
  NAVIGATION_SIDEBAR_USER_CHANGELOG: 'navigation.sidebar.user.changelog',
  NAVIGATION_SIDEBAR_USER_SETTINGS: 'navigation.sidebar.user.settings',
  NAVIGATION_SIDEBAR_COST: 'navigation.sidebar.cost',
} as const;

export type PermissionId =
  | (typeof PERMISSIONS)[keyof typeof PERMISSIONS]
  | string;
