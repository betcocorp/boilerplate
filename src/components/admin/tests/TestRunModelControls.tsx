'use client';

import { useState } from 'react';

import { FormSelectField } from '~/components/admin/FormSelectField';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import {
  BEX_CHAT_AGENT_MODES,
  BEX_CHAT_AGENT_MODE_LABELS,
  DEFAULT_BEX_CHAT_AGENT_MODE,
  type BexChatAgentMode,
} from '~/lib/agents/agent-registry';
import supportedModels, {
  type BexModelTag,
  type SupportedModel,
} from '~/lib/constants/models';
import { groupModelsByProvider } from '~/lib/llm/provider-label';
import { ROUTING_TEST_ROUTER_LABELS } from '~/lib/routing-test/constants';
import type { RouterTypeOverride } from '~/lib/workflows/product-support/run-product-support-workflow';

/** Router options this form's `routerType` select offers — mirrors the `/admin/routing-test` tool. */
const ROUTER_TYPE_OPTIONS: readonly RouterTypeOverride[] = [
  'keyword',
  'semantic',
  'llm',
];

/**
 * B0-601 — model selector + validator toggle for the "Run dataset" form.
 * B0-681 — added the router selector next to it: leaving it on "default" runs the turn through the
 * live `settings`-driven router (semantic/LLM rollout levers), same as before this ticket; picking
 * a router forces that run onto exactly that one (see `RouterTypeOverride`).
 * B0-351 — added the agent-mode selector: `Orchestrator` (the default, and what every run did
 * before this ticket) auto-selects a specialist by intent; any other value forces every item in the
 * run onto that one specialist, the same direct-routing mechanism the Bex chat composer exposes.
 * The options come from `BEX_CHAT_AGENT_MODES`, so this picker cannot drift from the chat one.
 *
 * A client component purely so the description under the dropdown can react to the selection; the
 * inputs are plain named form fields, so the enclosing server-action form (`runTestAction`) submits
 * them exactly as it did when this was inline markup.
 *
 * The `custom` tag is deliberately not offered: `resolveResponsesModel` throws on it unless
 * `BEX_RESPONSES_MODEL` is set, so it can only ever produce a failed run.
 */
export function TestRunModelControls() {
  const [modelTag, setModelTag] = useState<BexModelTag>('gpt-4.1');
  const [routerType, setRouterType] = useState<RouterTypeOverride | ''>('llm');
  const [agentMode, setAgentMode] = useState<BexChatAgentMode>(
    DEFAULT_BEX_CHAT_AGENT_MODE,
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Select
          name="modelTag"
          onValueChange={(v) => setModelTag(v as BexModelTag)}
          value={modelTag}
        >
          <SelectTrigger
            aria-label="Chat model for this run"
            className="h-9 w-44"
          >
            <SelectValue />
          </SelectTrigger>
          {/* B0-905 — grouped by vendor: the list carries both OpenAI and Anthropic tags since
              B0-908, and an ungrouped flat list gave no clue which vendor a run would bill. */}
          <SelectContent>
            <SelectItem value="preview">Model: preview</SelectItem>
            {groupModelsByProvider(supportedModels).map((group) => (
              <SelectGroup key={group.provider}>
                <SelectLabel>{group.label}</SelectLabel>
                {group.models.map((m: SupportedModel) => (
                  <SelectItem key={m.name} value={m.name}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>

        <FormSelectField
          ariaLabel="Router for this run"
          className="h-9 w-40"
          name="routerType"
          onValueChange={(v) => setRouterType(v as RouterTypeOverride | '')}
          options={[
            { value: '', label: 'Router: default' },
            ...ROUTER_TYPE_OPTIONS.map((type) => ({
              value: type,
              label: `Router: ${ROUTING_TEST_ROUTER_LABELS[type]}`,
            })),
          ]}
          value={routerType}
        />

        <Select
          name="agentMode"
          onValueChange={(v) => setAgentMode(v as BexChatAgentMode)}
          value={agentMode}
        >
          <SelectTrigger
            aria-label="Agent mode for this run"
            className="h-9 w-48"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BEX_CHAT_AGENT_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                Agent: {BEX_CHAT_AGENT_MODE_LABELS[mode]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <label
          className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
          htmlFor="run-use-validator"
        >
          <input
            className="size-3.5 cursor-pointer accent-primary"
            id="run-use-validator"
            name="useValidator"
            type="checkbox"
          />
          Validator pass
        </label>
      </div>
    </div>
  );
}
