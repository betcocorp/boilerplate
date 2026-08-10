'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import type { PromptInsight } from '~/lib/observability/prompt-insights';

/**
 * Prompt insights are generated on demand and never persisted (`workflow_runs`
 * has no insights column, and the observability repository is read-only), so the
 * only place a generated result exists is this browser tab.
 *
 * The analysis panel and the JSON export button are siblings on the trace page,
 * so the result is held here rather than inside the panel — that is what lets the
 * export include insights "if any have been generated yet".
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

  const value = useMemo<RunInsightsState>(
    () => ({
      insights,
      generatedAt,
      setResult: (nextInsights, nextGeneratedAt) => {
        setInsights(nextInsights);
        setGeneratedAt(nextGeneratedAt);
      },
    }),
    [insights, generatedAt],
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
