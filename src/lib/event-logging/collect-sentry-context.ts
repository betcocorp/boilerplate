import * as Sentry from '@sentry/nextjs';

type ScopeLike = {
  getUser?: () => unknown;
  getTags?: () => Record<string, string>;
  getContexts?: () => Record<string, unknown>;
  getBreadcrumbs?: () => unknown[];
  getScopeData?: () => unknown;
  getLastEventId?: () => string | undefined;
};

function tryGetScopeData(scope: ScopeLike): Record<string, unknown> | undefined {
  try {
    if (typeof scope.getScopeData === 'function') {
      const data = scope.getScopeData();
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        return data as Record<string, unknown>;
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

function browserHints(): Record<string, unknown> | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return {
      language: typeof navigator !== 'undefined' ? navigator.language : undefined,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      href: window.location?.href,
      pathname: window.location?.pathname,
      referrer: typeof document !== 'undefined' ? document.referrer : undefined,
      viewport:
        typeof window.innerWidth === 'number'
          ? { width: window.innerWidth, height: window.innerHeight }
          : undefined,
      screen:
        typeof window.screen !== 'undefined'
          ? { width: window.screen.width, height: window.screen.height }
          : undefined,
    };
  } catch {
    return undefined;
  }
}

function clientOptionsSnapshot(): Record<string, unknown> | undefined {
  const client = Sentry.getClient();
  const options = client?.getOptions();
  if (!options) return undefined;
  return {
    release: options.release,
    environment: options.environment,
    dist: options.dist,
  };
}

function sdkSnapshot(): Record<string, unknown> | undefined {
  const client = Sentry.getClient();
  const options = client?.getOptions();
  const meta = options?._metadata?.sdk;
  if (!meta?.name && !meta?.version) return undefined;
  return { name: meta.name, version: meta.version };
}

function activeSpanSnapshot(): Record<string, unknown> | undefined {
  try {
    const S = Sentry as typeof Sentry & {
      getActiveSpan?: () => unknown;
      spanToJSON?: (span: unknown) => unknown;
    };
    const span = S.getActiveSpan?.();
    if (!span || typeof S.spanToJSON !== 'function') return undefined;
    const json = S.spanToJSON(span);
    if (!json || typeof json !== 'object' || Array.isArray(json)) return undefined;
    return json as unknown as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function sanitizeForJson(value: unknown): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return { _sanitizeError: true };
  }
}

/**
 * Collects Sentry scope, SDK, trace, and (in the browser) basic navigator context
 * for persistence alongside an application event name.
 */
export function buildSentryPayloadForEvent(): Record<string, unknown> {
  const scope = Sentry.getCurrentScope() as ScopeLike;
  const scopeData = tryGetScopeData(scope);

  let isolationScopeData: Record<string, unknown> | undefined;
  try {
    const getIso = (Sentry as { getIsolationScope?: () => ScopeLike }).getIsolationScope;
    if (typeof getIso === 'function') {
      isolationScopeData = tryGetScopeData(getIso() as ScopeLike);
    }
  } catch {
    // ignore
  }

  const fallbackScope =
    scopeData == null
      ? {
          user: scope.getUser?.(),
          tags: scope.getTags?.(),
          contexts: scope.getContexts?.(),
          breadcrumbs: scope.getBreadcrumbs?.()?.slice(-50),
        }
      : undefined;

  const lastEventId =
    typeof scope.getLastEventId === 'function' ? scope.getLastEventId() : undefined;

  const raw: Record<string, unknown> = {
    clientOptions: clientOptionsSnapshot(),
    sdk: sdkSnapshot(),
    ...(scopeData ? { scopeData } : {}),
    ...(fallbackScope ? { scopeFallback: fallbackScope } : {}),
    ...(isolationScopeData ? { isolationScopeData } : {}),
    activeSpan: activeSpanSnapshot(),
    ...(typeof lastEventId === 'string' && lastEventId ? { lastEventId } : {}),
    browserHints: browserHints(),
  };

  return sanitizeForJson(raw);
}
