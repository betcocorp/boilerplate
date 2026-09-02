'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Skeleton } from '~/components/ui/skeleton';

import { BooleanToggleSetting } from './BooleanToggleSetting';
import { StringSelectSetting } from './StringSelectSetting';

type SettingRecord = {
  key: string;
  value: string;
  value_type: 'boolean' | 'string' | 'number';
  description?: string;
  allowed_values?: string[];
};

/**
 * Both lists are registries, not seeds: a key renders here only if a `settings` row with that key
 * (and a matching `value_type`) actually exists, so listing a key whose migration has not been
 * applied is inert rather than broken. B0-656 registers the whole semantic-router batch
 * (`ROUTER_TYPE` plus the `*_SEMANTIC_ROUTER_*` keys seeded by B0-648/B0-649) from one place,
 * because three tickets editing these two arrays in parallel is a guaranteed merge conflict.
 */
const BOOLEAN_SETTINGS = [
  'WEBSEARCH_DB_CACHE_ENABLED',
  'BEX_DISABLE_CONFIDENCE_GATING',
  // B0-734 — pre-model canned-decline gate (mixing / compliance / shelf-life / broad ask). Off by default.
  'BEX_EARLY_DECLINE_GATE_ENABLED',
  'BEX_PERMISSIONS_ENFORCED',
  // B0-68 — the AI SDK streaming/Elements/roundtrip rollout gates are retired (streaming and the
  // AI Elements transcript are unconditional). BEX_AI_SDK_GENERATION_ENABLED stays: per B0-378 it
  // is the permanent selector between the Responses and AI SDK generation loops, not a gate.
  'BEX_AI_SDK_GENERATION_ENABLED',
  'BEX_LLM_ROUTER_ENABLED',
  'BEX_LLM_ROUTER_SHADOW_MODE',
  'BEX_SEMANTIC_ROUTER_ENABLED',
  'BEX_SEMANTIC_ROUTER_SHADOW_MODE',
  // B0-786 — consolidated pre-orchestration signals analysis. Off = the scattered
  // intent-classifier + keyword path decides.
  'BEX_SIGNALS_ANALYSIS_ENABLED',
  'ENABLE_RERANKER',
  // B0-466 — observability alerting (tool-failure rate / golden-set pass rate).
  'ALERT_SENTRY_ENABLED',
  'ALERT_GOLDEN_GATE_MISS_ENABLED',
];

const STRING_SETTINGS = [
  'WEBSEARCH_PROVIDER',
  'OPENAI_EMBEDDING_MODEL',
  'XREF_RECOMMENDATION_TIMEOUT_MS',
  // B0-795 — cross-reference answer gate. Numeric 0-1; moved off process.env (B0-638 missed it).
  // NOT calibrated yet: read src/docs/cross-reference-recommendations.md before changing it, and
  // note BEX_DISABLE_CONFIDENCE_GATING currently bypasses this gate entirely.
  'XREF_RECOMMENDATION_MIN_CONFIDENCE',
  'COHERE_RERANK_MODEL',
  'ROUTER_TYPE',
  // B0-786 — model tag + latency ceiling for the intent/signals classifier call; both moved off
  // process.env per B0-638. BEX_ROUTER_TIMEOUT_MS is numeric (this list renders string and number).
  'BEX_ROUTER_MODEL',
  'BEX_ROUTER_TIMEOUT_MS',
  'SEMANTIC_ROUTER_EMBEDDING_MODEL',
  'SEMANTIC_ROUTER_CONFIDENCE_THRESHOLD',
  'SEMANTIC_ROUTER_MARGIN_THRESHOLD',
  // B0-466 — observability alert thresholds; all numeric, all 0-1 rates except the counts.
  'ALERT_TOOL_FAILURE_LOOKBACK_DAYS',
  'ALERT_TOOL_FAILURE_RATE_WARNING',
  'ALERT_TOOL_FAILURE_RATE_CRITICAL',
  'ALERT_TOOL_FAILURE_MIN_SETTLED_CALLS',
  'ALERT_TOOL_FAILURE_SPIKE_DELTA',
  'ALERT_TOOL_FAILURE_SPIKE_RATIO',
  'ALERT_GOLDEN_PASS_RATE_DROP_WARNING',
  'ALERT_GOLDEN_PASS_RATE_DROP_CRITICAL',
  'ALERT_GOLDEN_MIN_GRADED_ITEMS',
  // B0-719/B0-720 — multi-pass report grading. Numeric; 1 pass is the shipped default, and
  // raising it multiplies grading cost and wall clock by that many passes.
  'REPORT_GRADING_PASSES',
  'REPORT_CONSISTENCY_SPREAD_THRESHOLD',
  // B0-765 — model tag for run-report case grading + Top-3 findings synthesis.
  'REPORT_GRADING_MODEL',
];

export function SettingsPanel() {
  const [settings, setSettings] = useState<SettingRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  const fetchSettings = async () => {
    try {
      const response = await fetch('/api/admin/settings');
      if (!response.ok) throw new Error('Failed to fetch settings');
      const data = await response.json();
      setSettings(data.settings);
    } catch (error) {
      console.error('Error fetching settings:', error);
      toast.error('Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchSettings();
  }, []);

  const handleUpdateSetting = async (key: string, value: string) => {
    setSaving(key);
    try {
      const response = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to update setting');
      }

      // Update local state
      setSettings((prev) =>
        prev.map((s) => (s.key === key ? { ...s, value } : s)),
      );
      toast.success(`${key} updated`);
    } catch (error) {
      console.error('Error updating setting:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to update setting');
    } finally {
      setSaving(null);
    }
  };

  if (loading) {
    return (
      <div className="grid gap-6">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const booleanSettingsList = settings.filter(
    (s) => BOOLEAN_SETTINGS.includes(s.key) && s.value_type === 'boolean',
  ) as Array<SettingRecord & { value_type: 'boolean' }>;
  const stringSettingsList = settings.filter(
    (s) => STRING_SETTINGS.includes(s.key) && (s.value_type === 'string' || s.value_type === 'number'),
  ) as Array<SettingRecord & { value_type: 'string' | 'number' }>;

  return (
    <div className="grid gap-6">
      {/* Boolean Toggles Card */}
      <Card>
        <CardHeader>
          <CardTitle>Feature Toggles</CardTitle>
          <CardDescription>
            Enable or disable Bex features and subsystems.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6">
            {booleanSettingsList.map((setting) => (
              <BooleanToggleSetting
                key={setting.key}
                setting={setting}
                onUpdate={handleUpdateSetting}
                isSaving={saving === setting.key}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* String/Number Settings Card */}
      <Card>
        <CardHeader>
          <CardTitle>Configuration Options</CardTitle>
          <CardDescription>
            Adjust model selection, providers, and timing parameters.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6">
            {stringSettingsList.map((setting) => (
              <StringSelectSetting
                key={setting.key}
                setting={setting}
                onUpdate={handleUpdateSetting}
                isSaving={saving === setting.key}
              />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
