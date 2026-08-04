'use client';

import { useMemo, useState } from 'react';

import { Button } from '~/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '~/components/ui/command';
import { Label } from '~/components/ui/label';
import {
  Popover,
  PopoverContent,
  popoverScrollInDialogProps,
  PopoverTrigger,
} from '~/components/ui/popover';
import { cn } from '~/lib/utils';
import { ChevronDownIcon, XIcon } from 'lucide-react';

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
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');

  const selected = useMemo(
    () => agents.find((a) => a.id === value) ?? null,
    [agents, value],
  );

  return (
    <div className="flex flex-col gap-2">
      <Label className="text-sm text-slate-700" htmlFor={id}>
        {label}
      </Label>
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <Button
            aria-expanded={open}
            className={cn(
              'h-auto min-h-9 w-full justify-between rounded-3xl border border-transparent bg-input/50 px-3 py-2 font-normal whitespace-normal text-left hover:bg-input/60',
              !value && 'text-muted-foreground',
            )}
            id={id}
            role="combobox"
            type="button"
            variant="outline"
          >
            <span className="line-clamp-2 text-left">
              {selected ? (
                <>
                  <span className="font-medium text-foreground">{selected.label}</span>
                  <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                    {selected.id}
                  </span>
                </>
              ) : (
                placeholder
              )}
            </span>
            <ChevronDownIcon className="size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="flex max-h-[min(22rem,calc(100vh-8rem))] w-[min(100vw-2rem,var(--radix-popover-trigger-width))] flex-col gap-0 overflow-hidden p-0"
          // B0-359: rendered inside CreateTestFromPromptsDialog — same scroll lock applies.
          {...popoverScrollInDialogProps}
        >
          <Command
            className="flex min-h-0 flex-1 flex-col overflow-hidden size-auto! **:data-[slot=command-input-wrapper]:shrink-0"
            label="Search agents"
          >
            <CommandInput placeholder="Search by name or id…" />
            <CommandList className="max-h-[min(18rem,calc(100vh-12rem))] min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-py-1">
              <CommandEmpty>
                <p className="px-3 py-2 text-center text-xs text-muted-foreground">
                  No agent matches that search.
                </p>
              </CommandEmpty>
              <CommandGroup>
                {agents.map((agent) => (
                  <CommandItem
                    key={agent.id}
                    keywords={[agent.id, agent.label, agent.description]}
                    onSelect={() => {
                      setValue(agent.id);
                      setOpen(false);
                    }}
                    value={agent.id}
                  >
                    <div className="flex flex-col gap-0.5 py-0.5">
                      <span className="font-medium">{agent.label}</span>
                      <span className="text-xs text-muted-foreground">{agent.id}</span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
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
