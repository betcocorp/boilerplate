import type { Conversation } from './types';

const STORAGE_KEY = 'bex.admin.sessions.v1';

export function loadSessions(): Conversation[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed as Conversation[];
  } catch {
    return [];
  }
}

export function saveSessions(sessions: Conversation[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}

export function createConversation(): Conversation {
  return {
    id: crypto.randomUUID(),
    title: 'New conversation',
    updatedAt: Date.now(),
    messages: [],
  };
}
