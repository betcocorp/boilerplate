export type ChatRole = 'user' | 'assistant' | 'system';

export type ChatSourceRef = {
  documentId: string;
  chunkId?: string;
  title: string;
  snippet: string;
  similarity?: number;
};

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  workflowRunId?: string;
  meta?: {
    model?: string;
    confidence?: number;
    workflowRunId?: string;
    sources?: ChatSourceRef[];
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
