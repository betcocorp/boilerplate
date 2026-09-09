import { modelProviderFor, type ModelProvider } from '~/lib/constants/models';

/**
 * B0-905 — the one place a `ModelProvider` id is turned into the vendor name a person reads. Every
 * model picker group heading, vendor badge and report header goes through this, so "OpenAI" and
 * "Anthropic" are spelled the same way everywhere.
 */
export const PROVIDER_LABELS = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
} as const satisfies Record<ModelProvider, string>;

export type ProviderLabel = (typeof PROVIDER_LABELS)[ModelProvider];

/** Picker group order: the OpenAI tags first (the pre-B0-908 list), then their Anthropic equivalents. */
export const PROVIDER_ORDER: readonly ModelProvider[] = ['openai', 'anthropic'];

export function providerLabel(provider: ModelProvider): ProviderLabel {
  return PROVIDER_LABELS[provider];
}

/** Vendor name for a model tag or a resolved model id, via `modelProviderFor` (prefix test). */
export function providerLabelForModel(modelOrTag: string): ProviderLabel {
  return providerLabel(modelProviderFor(modelOrTag));
}

export function isModelProvider(value: unknown): value is ModelProvider {
  return typeof value === 'string' && Object.hasOwn(PROVIDER_LABELS, value);
}

export type ProviderModelGroup<T> = {
  provider: ModelProvider;
  label: ProviderLabel;
  models: T[];
};

/**
 * Splits a model list into one group per vendor, in `PROVIDER_ORDER`, keeping each model's position
 * within its group. Vendors with no model are omitted, so a picker never renders an empty heading.
 */
export function groupModelsByProvider<T extends { name: string }>(
  models: readonly T[],
): ProviderModelGroup<T>[] {
  return PROVIDER_ORDER.map((provider) => ({
    provider,
    label: providerLabel(provider),
    models: models.filter((model) => modelProviderFor(model.name) === provider),
  })).filter((group) => group.models.length > 0);
}
