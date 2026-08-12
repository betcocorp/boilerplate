'use client';

import {
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeftClose,
  Search,
  Trash2,
} from 'lucide-react';
import { useMemo } from 'react';

import { BexSidebarRowsSkeleton } from '~/components/bex/BexChatSkeleton';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { Input } from '~/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Switch } from '~/components/ui/switch';
import { cn } from '~/lib/utils';

import type { Conversation, ConversationOwner } from '~/types/bex';

type BexChatSidebarProps = {
  conversations: Conversation[];
  activeId: string | null;
  filter: string;
  onFilterChange: (value: string) => void;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onDelete: (id: string) => void;
  onCloseMobile?: () => void;
  className?: string;
  /** B0-345: conversation list still loading — show skeleton rows, not the empty state. */
  isLoading?: boolean;
  /**
   * B0-451 — it-admin-only chrome (owner badges + source/user filters). Computed in
   * `BexChatApp` from `usePermissionsStore().hasPermission(PERMISSIONS.BEX_CHAT_VIEW_ALL)` and
   * passed down rather than having this component read the store directly, keeping permission
   * state owned in one place (alongside `sessions`/`activeId`).
   */
  isAdminChrome?: boolean;
  /** "Show test runs" toggle — server-side `?source=` filter; default off (see B0-451 AC). */
  showTestRuns?: boolean;
  onShowTestRunsChange?: (value: boolean) => void;
  /** Selected owner `userId`, or `null` for "all users". */
  userFilter?: string | null;
  onUserFilterChange?: (value: string | null) => void;
};

const ALL_USERS_FILTER_VALUE = '__all__';

function ownerBadge(owner: ConversationOwner): { label: string; variant: 'secondary' | 'outline' } {
  if (owner === 'admin') {
    return { label: 'Admin', variant: 'secondary' };
  }
  if (owner === null) {
    return { label: 'Unattributed', variant: 'outline' };
  }
  return { label: owner.name, variant: 'outline' };
}

function formatRelative(updatedAt: number) {
  const diff = Date.now() - updatedAt;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatClock(updatedAt: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(updatedAt));
}

export function BexChatSidebar({
  activeId,
  className,
  conversations,
  filter,
  isAdminChrome = false,
  isLoading = false,
  onCloseMobile,
  onDelete,
  onFilterChange,
  onNewChat,
  onSelect,
  onShowTestRunsChange,
  onUserFilterChange,
  showTestRuns = false,
  userFilter = null,
}: BexChatSidebarProps) {
  const q = filter.trim().toLowerCase();
  const filtered = q
    ? conversations.filter((c) => c.title.toLowerCase().includes(q))
    : conversations;

  // B0-451 — no dedicated "list all users" endpoint (out of scope); options come from the
  // distinct owners already present in the currently-loaded, source-filtered list. A known,
  // acceptable limitation given the 80-row cap.
  const userFilterOptions = useMemo(() => {
    const byUserId = new Map<string, string>();
    for (const c of conversations) {
      if (c.owner && typeof c.owner === 'object') {
        byUserId.set(c.owner.userId, c.owner.name);
      }
    }
    return Array.from(byUserId.entries()).map(([userId, name]) => ({ userId, name }));
  }, [conversations]);

  return (
    <div
      className={cn(
        'flex h-full min-h-0 w-full flex-col border-border/60 bg-muted/30 lg:w-[280px] lg:border-r',
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-border/60 p-3">
        <Button
          className="flex-1 rounded-2xl"
          onClick={onNewChat}
          size="sm"
          type="button"
        >
          <MessageSquarePlus className="size-4" />
          New chat
        </Button>
        {onCloseMobile ? (
          <Button
            aria-label="Close conversation list"
            className="rounded-2xl lg:hidden"
            onClick={onCloseMobile}
            size="icon-sm"
            type="button"
            variant="outline"
          >
            <PanelLeftClose className="size-4" />
          </Button>
        ) : null}
      </div>

      <div className="p-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search conversations"
            className="h-10 rounded-2xl pl-9"
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder="Search chats…"
            value={filter}
          />
        </div>
      </div>

      {isAdminChrome ? (
        <div className="flex flex-col gap-2 px-3 pb-2">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              aria-label="Show test runs"
              checked={showTestRuns}
              onCheckedChange={(value) => onShowTestRunsChange?.(value)}
              size="sm"
            />
            Show test runs
          </label>
          <Select
            onValueChange={(value) =>
              onUserFilterChange?.(value === ALL_USERS_FILTER_VALUE ? null : value)
            }
            value={userFilter ?? ALL_USERS_FILTER_VALUE}
          >
            <SelectTrigger
              aria-label="Filter by user"
              className="h-9 w-full rounded-2xl bg-muted/40 text-xs"
              size="sm"
            >
              <SelectValue placeholder="All users" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_USERS_FILTER_VALUE}>All users</SelectItem>
              {userFilterOptions.map((option) => (
                <SelectItem key={option.userId} value={option.userId}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
        {isLoading ? (
          <BexSidebarRowsSkeleton />
        ) : filtered.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            {conversations.length === 0
              ? 'No conversations yet. Start one from the welcome screen.'
              : 'No chats match your search.'}
          </p>
        ) : (
          filtered.map((c) => {
            const isActive = c.id === activeId;
            const lastPreview = c.messages.length
              ? (c.messages[c.messages.length - 1]?.content ?? '')
                  .trim()
                  .replace(/\s+/g, ' ')
              : '';
            const badge = isAdminChrome ? ownerBadge(c.owner) : null;

            return (
              <div
                className={cn(
                  'group flex items-center gap-1 rounded-2xl transition-colors',
                  isActive ? 'bg-accent/80' : 'hover:bg-muted/80',
                )}
                key={c.id}
              >
                <Button
                  className="h-auto min-w-0 flex-1 justify-start px-3 py-2.5 text-left text-sm"
                  onClick={() => {
                    onSelect(c.id);
                    onCloseMobile?.();
                  }}
                  type="button"
                  variant="ghost"
                >
                  <span className="flex w-full min-w-0 flex-col items-start gap-0.5">
                    <span className="flex w-full items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="min-w-0 truncate">
                        {formatClock(c.updatedAt)} · {formatRelative(c.updatedAt)}
                        {c.messages.length > 0
                          ? ` · ${c.messages.length} msg`
                          : ''}
                      </span>
                      {badge ? (
                        <Badge
                          className="shrink-0 rounded-full px-1.5 py-0 text-[0.62rem]"
                          variant={badge.variant}
                        >
                          {badge.label}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="line-clamp-4 w-full font-medium text-foreground">
                      {c.title}
                    </span>
                    {lastPreview ? (
                      <span className="line-clamp-1 w-full text-xs text-muted-foreground">
                        {lastPreview}
                      </span>
                    ) : null}
                  </span>
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      aria-label={`More actions for ${c.title}`}
                      className="shrink-0 opacity-60 hover:opacity-100 group-hover:opacity-100"
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem
                      className="gap-2 text-destructive focus:text-destructive"
                      onClick={() => onDelete(c.id)}
                    >
                      <Trash2 className="size-4" />
                      Delete chat
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
