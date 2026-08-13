export type ChatRole = 'user' | 'assistant' | 'system';

export type ChatSourceRef = {
  documentId: string;
  chunkId?: string;
  title: string;
  snippet: string;
  similarity?: number;
  /** WEB-6: external (web) sources render as clickable links in the Sources panel. */
  kind?: 'internal' | 'external';
  url?: string;
};

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  workflowRunId?: string;
  feedback?: {
    rating: 'up' | 'down';
    reasonCode?: string | null;
    comment?: string | null;
    createdAt?: number;
    updatedAt?: number;
  } | null;
  meta?: {
    model?: string;
    confidence?: number;
    workflowRunId?: string;
    sources?: ChatSourceRef[];
    toolSummary?: Array<{
      name: string;
      ok: boolean;
    }>;
    validation?: {
      approved: boolean;
      requiresHumanReview: boolean;
      issues?: string[];
    };
  };
};

/**
 * B0-451 — admin sidebar owner attribution. `'admin'` for test-runner conversations (never a real
 * user, per B0-450); `null` for a legacy/unresolved `source: 'chat'` row with no owner ("Unattributed");
 * otherwise the resolved user. `userId` is included so the "filter by user" control has a value to
 * send back as `?userFilter=`.
 */
export type ConversationOwner =
  | { name: string; email: string | null; userId: string }
  | 'admin'
  | null;

export type ConversationSource = 'chat' | 'test_run';

export type Conversation = {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
  owner: ConversationOwner;
  source: ConversationSource;
  /** Strict ownership (actor is the real user_id owner), independent of view-all/service access. */
  isOwner: boolean;
};
