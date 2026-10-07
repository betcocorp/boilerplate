import { Badge } from '~/components/ui/badge';
import { shortHash } from '~/lib/workflows/product-support/prompt-version';
import type { PromptBundleVersionSummary } from '~/lib/tests/response-payload';

/**
 * B0-398 — the run-level `promptBundleVersion` chip, used on both the run detail header and the
 * "Recent runs" list on the test detail page. Renders nothing for pre-capture runs (AC: never a
 * misleading placeholder). When a run's items disagree on `promptBundleVersion` (should only
 * happen if a deploy landed mid-run), shows the distinct-value count instead of picking one hash
 * to display as if it applied to the whole run.
 */
export function PromptBundleVersionBadge({
  summary,
}: {
  summary: PromptBundleVersionSummary;
}) {
  if (summary.kind === 'none') {
    return null;
  }

  if (summary.kind === 'multiple') {
    return (
      <Badge
        title="Items in this run disagree on promptBundleVersion (e.g. a deploy happened mid-run)"
        variant="outline"
      >
        {summary.count} bundle versions
      </Badge>
    );
  }

  return (
    <Badge title={`promptBundleVersion: ${summary.value}`} variant="outline">
      bundle {shortHash(summary.value)}
    </Badge>
  );
}
