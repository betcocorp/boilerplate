const UI_CACHE_KEY = 'bex.admin.ui.v2';

export type BexUiCache = {
  lastActiveConversationId: string | null;
  model: string;
  useValidator: boolean;
};

const defaultCache: BexUiCache = {
  lastActiveConversationId: null,
  model: 'preview',
  useValidator: false,
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

    return { lastActiveConversationId, model, useValidator };
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
