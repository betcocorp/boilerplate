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

export type Conversation = {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
};
