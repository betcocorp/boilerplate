/**
 * Permission identifiers (must match `public.permission.selector` values).
 * Use for UI checks and requirePermission() in API routes.
 *
 * The `navigation.sidebar.*` selectors mirror the ten admin surfaces under
 * `src/app/(authenticated)/admin/` (see `~/components/admin/AdminSidebarNav`).
 */
export const PERMISSIONS = {
  /** Admin sidebar: Bex chat. */
  NAVIGATION_SIDEBAR_BEX: 'navigation.sidebar.bex',
  /** Admin sidebar: Products (RAG generate, corpus quality, legacy, orphans). */
  NAVIGATION_SIDEBAR_PRODUCTS: 'navigation.sidebar.products',
  /** Admin sidebar: SDS ingestion. */
  NAVIGATION_SIDEBAR_SDS: 'navigation.sidebar.sds',
  /** Admin sidebar: Efficacy ingestion. */
  NAVIGATION_SIDEBAR_EFFICACY: 'navigation.sidebar.efficacy',
  /** Admin sidebar: Product label ingestion. */
  NAVIGATION_SIDEBAR_LABELS: 'navigation.sidebar.labels',
  /** Admin sidebar: Markdown / knowledge ingestion. */
  NAVIGATION_SIDEBAR_KNOWLEDGE: 'navigation.sidebar.knowledge',
  /** Admin sidebar: test runner + failure queue. */
  NAVIGATION_SIDEBAR_TESTS: 'navigation.sidebar.tests',
  /** Admin sidebar: prompt observability. */
  NAVIGATION_SIDEBAR_OBSERVABILITY: 'navigation.sidebar.observability',
  /** Admin sidebar: tools (cross-reference, web search, semantic search). */
  NAVIGATION_SIDEBAR_TOOLS: 'navigation.sidebar.tools',
  /** Admin account menu: API access (Projects + Analytics). */
  NAVIGATION_SIDEBAR_PROJECTS: 'navigation.sidebar.projects',
  /** Admin dashboard: show the permissions administration card. */
  ADMIN_CARD_PERMISSIONS: 'admin.card.permissions',
  /** Bex chat: send messages / use the assistant. */
  BEX_CHAT_USE: 'bex.chat.use',
  /** Bex chat: choose the agent mode. */
  BEX_AGENT_MODE_SELECT: 'bex.agent_mode.select',
  /** Bex chat: view every user's conversations (it-admin only). */
  BEX_CHAT_VIEW_ALL: 'bex.chat.view-all',
} as const;

export type PermissionId =
  | (typeof PERMISSIONS)[keyof typeof PERMISSIONS]
  | string;
