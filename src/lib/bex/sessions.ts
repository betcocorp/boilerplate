const UI_CACHE_KEY = 'bex.admin.ui.v2';

export type BexUiCache = {
  lastActiveConversationId: string | null;
  model: string;
  useValidator: boolean;
  agentMode: 'orchestrator' | 'product' | 'bathroom' | 'dilution' | 'floor';
};

const defaultCache: BexUiCache = {
  lastActiveConversationId: null,
  model: 'preview',
  useValidator: false,
  agentMode: 'orchestrator',
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
    const agentMode =
      o.agentMode === 'product' ||
      o.agentMode === 'bathroom' ||
      o.agentMode === 'dilution' ||
      o.agentMode === 'floor' ||
      o.agentMode === 'orchestrator'
        ? o.agentMode
        : 'orchestrator';

    return { lastActiveConversationId, model, useValidator, agentMode };
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
