import {
  DEFAULT_BEX_CHAT_AGENT_MODE,
  isBexChatAgentMode,
  type BexChatAgentMode,
} from '~/lib/agents/agent-registry';

// B0-451 — bumped from v2: added admin-only sidebar filter state (showTestRuns, userFilter).
const UI_CACHE_KEY = 'bex.admin.ui.v3';

export type BexUiCache = {
  lastActiveConversationId: string | null;
  model: string;
  useValidator: boolean;
  agentMode: BexChatAgentMode;
  /** B0-451 — admin-only "show test runs" toggle; default off (test_run rows outnumber chat ~11:1). */
  showTestRuns: boolean;
  /** B0-451 — admin-only "filter by user" selection; a conversation owner's userId, or null (all). */
  userFilter: string | null;
};

const defaultCache: BexUiCache = {
  lastActiveConversationId: null,
  model: 'preview',
  useValidator: false,
  agentMode: DEFAULT_BEX_CHAT_AGENT_MODE,
  showTestRuns: false,
  userFilter: null,
};

export function loadUiCache(): BexUiCache {
  if (typeof window === 'undefined') {
    return defaultCache;
  }

  try {
    const raw = localStorage.getItem(UI_CACHE_KEY);
    if (!raw) {
      return defaultCache;
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return defaultCache;
    }

    const o = parsed as Record<string, unknown>;
    const model =
      typeof o.model === 'string' && o.model.trim() ? o.model.trim() : 'preview';
    const lastActiveConversationId =
      typeof o.lastActiveConversationId === 'string' &&
      o.lastActiveConversationId.trim()
        ? o.lastActiveConversationId.trim()
        : null;
    const useValidator = typeof o.useValidator === 'boolean' ? o.useValidator : false;
    const agentMode = isBexChatAgentMode(o.agentMode)
      ? o.agentMode
      : DEFAULT_BEX_CHAT_AGENT_MODE;
    const showTestRuns = typeof o.showTestRuns === 'boolean' ? o.showTestRuns : false;
    const userFilter =
      typeof o.userFilter === 'string' && o.userFilter.trim() ? o.userFilter.trim() : null;

    return {
      lastActiveConversationId,
      model,
      useValidator,
      agentMode,
      showTestRuns,
      userFilter,
    };
  } catch {
    return defaultCache;
  }
}

export function saveUiCache(cache: BexUiCache) {
  if (typeof window === 'undefined') {
    return;
  }

  localStorage.setItem(UI_CACHE_KEY, JSON.stringify(cache));
}
