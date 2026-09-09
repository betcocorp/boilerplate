import { Badge } from '~/components/ui/badge';
import { modelProviderFor, type ModelProvider } from '~/lib/constants/models';
import { isModelProvider, providerLabel } from '~/lib/llm/provider-label';
import { cn } from '~/lib/utils';

/**
 * Subtle per-vendor tint, tokens only (no raw palette) so it follows the theme. Both stay `outline`
 * badges; the tint is a hint, the text is the fact.
 */
const PROVIDER_CLASS_NAMES: Record<ModelProvider, string> = {
  openai: 'border-primary/30 bg-primary/5 text-primary',
  anthropic: 'border-accent-foreground/30 bg-accent text-accent-foreground',
};

type ModelProviderBadgeProps = {
  /**
   * The resolved model id (or explicit tag) the vendor is derived from. The vendor is read off the
   * id itself (`modelProviderFor` — a `claude-` prefix test), so a run that predates
   * `summary.resolvedProvider` (B0-905) still gets a correct badge from its persisted
   * `resolvedModel`. Null/empty renders nothing: a badge is only ever shown for a KNOWN model.
   */
  model: string | null | undefined;
  /**
   * The persisted provider, when the caller has one (`summary.resolvedProvider`). Used as-is when
   * valid; otherwise derived from `model`. Never lets a badge appear without a model, so an
   * orphaned provider value cannot badge an unknown run.
   */
  provider?: string | null;
  className?: string;
};

/**
 * B0-905 — "OpenAI" / "Anthropic" vendor chip for a model id, shown next to the model on the
 * /admin/tests run list and run-detail header. Renders nothing rather than a guess when the
 * model is unknown.
 */
export function ModelProviderBadge({ model, provider, className }: ModelProviderBadgeProps) {
  const modelId = typeof model === 'string' ? model.trim() : '';
  if (!modelId) return null;

  const resolvedProvider: ModelProvider = isModelProvider(provider)
    ? provider
    : modelProviderFor(modelId);
  const label = providerLabel(resolvedProvider);

  return (
    <Badge
      className={cn('px-1.5 py-0 text-[10px] font-medium', PROVIDER_CLASS_NAMES[resolvedProvider], className)}
      data-provider={resolvedProvider}
      title={`${label} model — vendor derived from the model id "${modelId}"`}
      variant="outline"
    >
      {label}
    </Badge>
  );
}
