'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type { PromptInsight } from '~/lib/observability/prompt-insights';

/**
 * Holds the trace page's prompt insights for the current tab.
 *
 * The analysis panel and the JSON export button are siblings on the trace page,
 * so the result is held here rather than inside the panel — that is what lets the
 * export include insights "if any have been generated yet".
 *
 * B0-420 — insights are now persisted under `ai_suggestions` (scope
 * `workflow_run`), so the panel hydrates this from storage on mount instead of
 * starting empty on every visit. This context is still the only place the
 * *current* tab's result lives.
 */

type RunInsightsState = {
  insights: PromptInsight[] | null;
  generatedAt: string | null;
  setResult: (insights: PromptInsight[], generatedAt: string | null) => void;
};

const RunInsightsContext = createContext<RunInsightsState | null>(null);

export function RunInsightsProvider({ children }: { children: ReactNode }) {
  const [insights, setInsights] = useState<PromptInsight[] | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);

  /**
   * Stable across renders: the panel's hydrate-on-mount effect (B0-420) lists this in its
   * dependency array, and a setter that changed on every state update would re-run that
   * effect after its own `setResult` call.
   */
  const setResult = useCallback(
    (nextInsights: PromptInsight[], nextGeneratedAt: string | null) => {
      setInsights(nextInsights);
      setGeneratedAt(nextGeneratedAt);
    },
    [],
  );

  const value = useMemo<RunInsightsState>(
    () => ({ insights, generatedAt, setResult }),
    [insights, generatedAt, setResult],
  );

  return (
    <RunInsightsContext.Provider value={value}>{children}</RunInsightsContext.Provider>
  );
}

export function useRunInsights(): RunInsightsState {
  const context = useContext(RunInsightsContext);
  if (!context) {
    throw new Error('useRunInsights must be used inside <RunInsightsProvider>.');
  }
  return context;
}
