'use client';

import { Label } from '~/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Textarea } from '~/components/ui/textarea';
import { ROUTING_TEST_AGENT_OPTIONS } from '~/lib/routing-test/agent-options';

type RoutingTestItemFieldsProps = {
  /** Unique per dialog instance so labels bind to the right controls. */
  idPrefix: string;
  defaultPrompt?: string;
  defaultExpectedAgent?: string;
};

/**
 * The two fields a routing test item has — nothing else. Shared by the add and edit dialogs.
 * Options come from `SME_AGENT_IDS` via `ROUTING_TEST_AGENT_OPTIONS`, never a hardcoded list.
 */
export function RoutingTestItemFields({
  idPrefix,
  defaultPrompt = '',
  defaultExpectedAgent = '',
}: RoutingTestItemFieldsProps) {
  const promptId = `${idPrefix}-prompt`;
  const agentId = `${idPrefix}-expected-agent`;

  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor={promptId}>Prompt</Label>
        <Textarea
          defaultValue={defaultPrompt}
          id={promptId}
          name="prompt"
          placeholder="e.g. What dilution ratio should I use for pH7Q in a mop bucket?"
          required
          rows={5}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={agentId}>Expected agent</Label>
        <Select defaultValue={defaultExpectedAgent || undefined} name="expectedAgent" required>
          <SelectTrigger id={agentId}>
            <SelectValue placeholder="Select the agent this prompt should route to…" />
          </SelectTrigger>
          <SelectContent>
            {ROUTING_TEST_AGENT_OPTIONS.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label} ({option.id})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  );
}
