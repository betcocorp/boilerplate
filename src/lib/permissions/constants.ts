/**
 * Permission identifiers (must match `public.permission.selector` values).
 * Use for UI checks and requirePermission() in API routes.
 *
 * The `navigation.sidebar.*` selectors mirror the admin surfaces under
 * `src/app/(authenticated)/admin/` (see `~/components/admin/AdminSidebarNav*`).
 */
export const PERMISSIONS = {
  DASHBOARD_PERMISSIONS_CARD: 'dashboard.permissions.card',
  SIDEBAR_NAVIGATION_API_PERMISSIONS: 'sidebar.navigation.api_permissions',
  SIDEBAR_NAVIGATION_INGESTION: 'sidebar.navigation.ingestion',
  SIDEBAR_NAVIGATION_PRODUCT_ORPHAN: 'sidebar.navigation.product.orphan',
  SIDEBAR_NAVIGATION_PRODUCTS_CORPUS: 'sidebar.navigation.products.corpus',
  SIDEBAR_NAVIGATION_PRODUCTS_GENERATE: 'sidebar.navigation.products.generate',
  SIDEBAR_NAVIGATION_PRODUCTS_LEGACY: 'sidebar.navigation.products.legacy',

  DASHBOARD_PERMISSIONS_CARD: 'dashboard.permissions.card',
  ADMIN_CARD_PERMISSIONS: 'admin.card.permissions',

  BEX_CHAT_USE: 'bex.chat.use',
  BEX_CHAT_VIEW_ALL: 'bex.chat.view-all',

  NAVIGATION_SIDEBAR_BEX: 'navigation.sidebar.bex',
  NAVIGATION_SIDEBAR_PRODUCTS: 'navigation.sidebar.products',
  NAVIGATION_SIDEBAR_SDS: 'navigation.sidebar.sds',
  NAVIGATION_SIDEBAR_EFFICACY: 'navigation.sidebar.efficacy',
  NAVIGATION_SIDEBAR_LABELS: 'navigation.sidebar.labels',
  NAVIGATION_SIDEBAR_KNOWLEDGE: 'navigation.sidebar.knowledge',
  NAVIGATION_SIDEBAR_TESTS: 'navigation.sidebar.tests',
  NAVIGATION_SIDEBAR_OBSERVABILITY: 'navigation.sidebar.observability',
  NAVIGATION_SIDEBAR_TOOLS: 'navigation.sidebar.tools',
  NAVIGATION_SIDEBAR_PROJECTS: 'navigation.sidebar.projects',

  /**
   * Backward-compatible aliases for older constant names still used in parts of the app.
   */
  SIDEBAR_NAVIGATION_API_PERMISSIONS: 'navigation.sidebar.projects',
  SIDEBAR_NAVIGATION_INGESTION: 'navigation.sidebar.sds',
} as const;

export type PermissionId =
  | (typeof PERMISSIONS)[keyof typeof PERMISSIONS]
  | string;
