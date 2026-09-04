'use client';

import { XIcon } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '~/components/ui/button';
import { Label } from '~/components/ui/label';
import { LabeledCombobox } from '~/components/ui/labeled-combobox';

export type TestIntendedAgentOption = {
  id: string;
  label: string;
  description: string;
};

type TestIntendedAgentComboboxProps = {
  id: string;
  name?: string;
  label: string;
  agents: readonly TestIntendedAgentOption[];
  placeholder?: string;
};

export function TestIntendedAgentCombobox({
  id,
  name = 'intendedAgent',
  label,
  agents,
  placeholder = 'Select intended agent…',
}: TestIntendedAgentComboboxProps) {
  const [value, setValue] = useState('');

  // The trigger/item sub-line shows the agent id (not `description`, which is a longer
  // blurb) — matches the original layout; description still feeds the search keywords.
  const options = useMemo(
    () =>
      agents.map((agent) => ({
        id: agent.id,
        label: agent.label,
        description: agent.id,
        keywords: [agent.description],
      })),
    [agents],
  );

  return (
    <div className="flex flex-col gap-2">
      <Label className="text-sm text-slate-700" htmlFor={id}>
        {label}
      </Label>
      <LabeledCombobox
        // B0-359 — rendered inside CreateTestFromPromptsDialog / CreateOrUploadTestDatasetDialog
        // (both Radix `Dialog`s) — same scroll lock applies.
        emptyText="No agent matches that search."
        id={id}
        onValueChange={setValue}
        options={options}
        placeholder={placeholder}
        renderInDialog
        searchPlaceholder="Search by name or id…"
        value={value || null}
      />
      <input name={name} type="hidden" value={value} />
      {value ? (
        <Button
          className="h-8 w-fit text-xs"
          onClick={() => setValue('')}
          size="sm"
          type="button"
          variant="ghost"
        >
          <XIcon className="mr-1 size-3.5" />
          Clear agent
        </Button>
      ) : null}
    </div>
  );
}
