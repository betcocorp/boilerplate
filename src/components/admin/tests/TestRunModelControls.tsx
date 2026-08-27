'use client';

import { useState } from 'react';

import { NativeSelect } from '~/components/ui/native-select';
import {
  BEX_CHAT_AGENT_MODES,
  BEX_CHAT_AGENT_MODE_LABELS,
  DEFAULT_BEX_CHAT_AGENT_MODE,
  type BexChatAgentMode,
} from '~/lib/agents/agent-registry';
import supportedModels, {
  MODEL_DESCRIPTIONS,
  type BexModelTag,
  type SupportedModel,
} from '~/lib/constants/models';
import { ROUTING_TEST_ROUTER_LABELS } from '~/lib/routing-test/constants';
import type { RouterTypeOverride } from '~/lib/workflows/product-support/run-product-support-workflow';

/** Router options this form's `routerType` select offers — mirrors the `/admin/routing-test` tool. */
const ROUTER_TYPE_OPTIONS: readonly RouterTypeOverride[] = ['keyword', 'semantic', 'llm'];

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
  const [routerType, setRouterType] = useState<RouterTypeOverride | ''>('');
  const [agentMode, setAgentMode] = useState<BexChatAgentMode>(
    DEFAULT_BEX_CHAT_AGENT_MODE,
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <NativeSelect
          aria-label="Chat model for this run"
          className="h-9 w-44"
          name="modelTag"
          onChange={(event) => setModelTag(event.target.value as BexModelTag)}
          value={modelTag}
        >
          <option value="preview">Model: preview</option>
          {supportedModels.map((m: SupportedModel) => (
            <option key={m.name} value={m.name}>
              {m.label}
            </option>
          ))}
        </NativeSelect>

        <NativeSelect
          aria-label="Router for this run"
          className="h-9 w-40"
          name="routerType"
          onChange={(event) =>
            setRouterType(event.target.value as RouterTypeOverride | '')
          }
          value={routerType}
        >
          <option value="">Router: default</option>
          {ROUTER_TYPE_OPTIONS.map((type) => (
            <option key={type} value={type}>
              Router: {ROUTING_TEST_ROUTER_LABELS[type]}
            </option>
          ))}
        </NativeSelect>

        <NativeSelect
          aria-label="Agent mode for this run"
          className="h-9 w-48"
          name="agentMode"
          onChange={(event) =>
            setAgentMode(event.target.value as BexChatAgentMode)
          }
          value={agentMode}
        >
          {BEX_CHAT_AGENT_MODES.map((mode) => (
            <option key={mode} value={mode}>
              Agent: {BEX_CHAT_AGENT_MODE_LABELS[mode]}
            </option>
          ))}
        </NativeSelect>

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

      <p className="max-w-md text-xs leading-snug text-muted-foreground">
        {MODEL_DESCRIPTIONS[modelTag]}
      </p>
    </div>
  );
}
