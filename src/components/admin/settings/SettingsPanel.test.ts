import { describe, expect, it } from 'vitest';

import { groupSettings, HIDDEN_UI_GROUP } from './SettingsPanel';
import type { SettingRecord } from './SettingRow';

const row = (key: string, ui_group: string | null, extra: Partial<SettingRecord> = {}): SettingRecord => ({
  key,
  value: 'x',
  value_type: 'string',
  ui_group,
  ...extra,
});

describe('groupSettings (B0-992)', () => {
  it('renders every non-hidden row, grouped by ui_group, with "Other" last', () => {
    const groups = groupSettings([
      row('Z_NEW_KEY_NOBODY_REGISTERED', null),
      row('RAG_CHUNK_MAX_TOKENS', HIDDEN_UI_GROUP),
      row('REPORT_PASS_MARK', 'Eval reports and grading'),
      row('BEX_FACT_TOOL_ENFORCEMENT_ENABLED', 'Bex answer pipeline'),
      row('ALERT_SENTRY_ENABLED', 'Observability alerts'),
    ]);
    expect(groups.map(([label]) => label)).toEqual([
      'Bex answer pipeline',
      'Eval reports and grading',
      'Observability alerts',
      'Other',
    ]);
    expect(groups.flatMap(([, rows]) => rows.map((r) => r.key))).not.toContain('RAG_CHUNK_MAX_TOKENS');
    expect(groups.find(([label]) => label === 'Other')?.[1].map((r) => r.key)).toEqual([
      'Z_NEW_KEY_NOBODY_REGISTERED',
    ]);
  });

  it('sorts rows inside a group by key', () => {
    const [[, rows]] = groupSettings([row('B', 'g'), row('A', 'g')]);
    expect(rows.map((r) => r.key)).toEqual(['A', 'B']);
  });
});
