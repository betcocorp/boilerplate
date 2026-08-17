import { Badge } from '~/components/ui/badge';
import type { RuntimeConfig } from '~/lib/workflows/product-support/product-support-schemas';

/**
 * B0-494 — run-level chip for the resolved runtime-switch snapshot, same family as the B0-398
 * `PromptBundleVersionBadge`. Renders nothing for a historical run that predates this ticket (AC:
 * never a misleading placeholder implying "fully enabled").
 *
 * The B0-452 kill switch (`confidenceGatingDisabled`) gets its own distinctly-styled badge: a run
 * executed under it must be identifiable at a glance, since any recorded confidence cap on that
 * run is fiction (the gate detected something but the kill switch stopped it from acting).
 */
export function RuntimeConfigBadge({
  runtimeConfig,
}: {
  runtimeConfig: RuntimeConfig | null;
}) {
  if (!runtimeConfig) {
    return null;
  }

  return (
    <>
      {runtimeConfig.confidenceGatingDisabled ? (
        <Badge
          title="BEX_DISABLE_CONFIDENCE_GATING was true for this run: confidence caps and rejections were detected but not enforced."
          variant="destructive"
        >
          confidence gating disabled
        </Badge>
      ) : null}
      <Badge
        title={`useValidator: ${runtimeConfig.useValidator}`}
        variant="outline"
      >
        validator {runtimeConfig.useValidator ? 'on' : 'off'}
      </Badge>
      <Badge
        title={`earlyDeclineGateEnabled: ${runtimeConfig.earlyDeclineGateEnabled}`}
        variant="outline"
      >
        decline gate {runtimeConfig.earlyDeclineGateEnabled ? 'on' : 'off'}
      </Badge>
      <Badge
        title={`aiSdkGenerationEnabled: ${runtimeConfig.aiSdkGenerationEnabled}`}
        variant="outline"
      >
        {runtimeConfig.aiSdkGenerationEnabled ? 'ai-sdk' : 'responses'} runtime
      </Badge>
      <Badge title={`rerankerActive: ${runtimeConfig.rerankerActive}`} variant="outline">
        reranker {runtimeConfig.rerankerActive ? 'on' : 'off'}
      </Badge>
      {runtimeConfig.routedDirectly ? (
        <Badge title={`agentMode: ${runtimeConfig.agentMode}`} variant="outline">
          forced {runtimeConfig.agentMode}
        </Badge>
      ) : null}
    </>
  );
}
