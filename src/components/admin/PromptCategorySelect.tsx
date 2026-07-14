'use client';

import { Fragment, useState, useTransition } from 'react';
import { Select as SelectPrimitive } from 'radix-ui';
import { CheckIcon } from 'lucide-react';

import {
  SelectGroup,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
} from '~/components/ui/select';
import {
  PROMPT_CATEGORIES_BY_GROUP,
  PROMPT_CATEGORY_BY_SLUG,
  PROMPT_CATEGORY_GROUP_COLORS,
  type PromptCategorySlug,
} from '~/lib/constants/prompt-categories';
import { updateTestItemCategory } from '~/lib/tests/actions';

type Props = {
  testItemId: string;
  currentCategory: string | null;
};

export function PromptCategorySelect({ testItemId, currentCategory }: Props) {
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState(currentCategory ?? '');

  const currentCat = value ? PROMPT_CATEGORY_BY_SLUG[value as PromptCategorySlug] : null;
  const dotColor = currentCat
    ? PROMPT_CATEGORY_GROUP_COLORS[currentCat.group]
    : 'bg-slate-300';

  function handleChange(next: string) {
    setValue(next);
    startTransition(async () => {
      await updateTestItemCategory(testItemId, next);
    });
  }

  return (
    <SelectPrimitive.Root value={value || undefined} disabled={isPending} onValueChange={handleChange}>
      <SelectTrigger
        className={[
          'h-auto w-fit gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1',
          'text-xs font-medium text-slate-700 shadow-sm',
          'hover:border-slate-300 hover:bg-slate-50',
          'focus:outline-none focus:ring-1 focus:ring-sky-300',
          'data-disabled:opacity-50',
          isPending ? 'animate-pulse' : '',
        ].join(' ')}
      >
        <span className="flex items-center gap-1.5">
          <span className={`size-1.5 shrink-0 rounded-full ${dotColor}`} />
          <span>{currentCat?.label ?? 'Uncategorized'}</span>
        </span>
      </SelectTrigger>

      {/*
        Build the popup directly with Radix primitives — bypasses the shadcn
        SelectContent wrapper which hardcodes `dark` class and always renders
        scroll-up/down buttons. This gives us a plain light-theme dropdown
        with no scroll indicators.
      */}
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          align="start"
          sideOffset={6}
          className={[
            'z-50 w-64 origin-(--radix-select-content-transform-origin)',
            'overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]',
            'rounded-2xl border border-slate-200 bg-white p-1 shadow-xl',
            'data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2',
            'data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95',
            'data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
          ].join(' ')}
          style={{ maxHeight: 'min(480px, var(--radix-select-content-available-height, 480px))' }}
        >
          <SelectPrimitive.ScrollUpButton className="hidden" />
          <SelectPrimitive.Viewport>
            {PROMPT_CATEGORIES_BY_GROUP.map(({ group, label, color, items }, i) => (
              <Fragment key={group}>
                {i > 0 && <SelectSeparator className="my-1 bg-slate-100" />}
                <SelectGroup>
                  <SelectLabel className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-widest text-slate-400">
                    <span className={`size-1.5 shrink-0 rounded-full ${color}`} />
                    {label}
                  </SelectLabel>
                  {items.map((cat) => (
                    <SelectPrimitive.Item
                      key={cat.slug}
                      value={cat.slug}
                      title={cat.description}
                      className={[
                        'relative flex w-full cursor-default select-none items-center',
                        'rounded-lg px-2 py-1.5 pr-7 text-xs text-slate-700 outline-none',
                        'data-[highlighted]:bg-slate-100 data-[highlighted]:text-slate-900',
                        'data-[state=checked]:font-semibold data-[state=checked]:text-sky-700',
                        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
                      ].join(' ')}
                    >
                      <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
                        <SelectPrimitive.ItemIndicator>
                          <CheckIcon className="size-3" />
                        </SelectPrimitive.ItemIndicator>
                      </span>
                      <SelectPrimitive.ItemText>{cat.label}</SelectPrimitive.ItemText>
                    </SelectPrimitive.Item>
                  ))}
                </SelectGroup>
              </Fragment>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="hidden" />
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
