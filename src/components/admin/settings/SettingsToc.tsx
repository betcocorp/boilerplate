'use client';

import { useEffect, useState } from 'react';

import { cn } from '~/lib/utils';

export const SETTINGS_TOC_CONTAINER_ID = 'admin-settings-content';

interface SettingsTocSection {
  id: string;
  label: string;
}

function readSections(): SettingsTocSection[] {
  const container = document.getElementById(SETTINGS_TOC_CONTAINER_ID);
  if (!container) return [];
  const nodes = container.querySelectorAll<HTMLElement>('[data-settings-toc-label]');
  return Array.from(nodes)
    .filter((node) => node.id)
    .map((node) => ({ id: node.id, label: node.dataset.settingsTocLabel ?? node.id }));
}

interface SettingsTocProps {
  className?: string;
}

/**
 * B0-1127 — section list isn't known up front like the changelog TOC's: the golden-set section
 * is server-rendered, but settings groups only exist once SettingsPanel's client fetch resolves.
 * So this scans the DOM under SETTINGS_TOC_CONTAINER_ID instead of taking sections as a prop, and
 * watches it with a MutationObserver to pick up groups that render in after the initial paint.
 */
export function SettingsToc({ className }: SettingsTocProps) {
  const [sections, setSections] = useState<SettingsTocSection[]>([]);

  useEffect(() => {
    const container = document.getElementById(SETTINGS_TOC_CONTAINER_ID);
    if (!container) return;

    const update = () => setSections(readSections());
    update();

    const observer = new MutationObserver(update);
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  if (sections.length === 0) {
    return null;
  }

  function handleClick(event: React.MouseEvent<HTMLAnchorElement>, id: string) {
    event.preventDefault();
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }

  return (
    <nav
      aria-label="Settings sections"
      className={cn(
        'rounded-2xl border border-border/60 bg-background shadow-sm',
        className,
      )}
    >
      <div className="border-b border-border/60 px-4 py-3">
        <p className="text-sm font-medium text-foreground">Sections</p>
      </div>
      <ul className="max-h-[70vh] space-y-1 overflow-y-auto p-2">
        {sections.map((section) => (
          <li key={section.id}>
            <a
              className="block truncate rounded-md px-3 py-1.5 text-sm text-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
              href={`#${section.id}`}
              onClick={(event) => handleClick(event, section.id)}
            >
              {section.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
