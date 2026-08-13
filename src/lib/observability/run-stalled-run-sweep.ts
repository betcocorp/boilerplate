/**
 * B0-371 — production wiring for the orphaned-run sweeper.
 *
 * The route handler (`/api/v1/observability/sweep-stalled-runs`) stays thin by
 * calling this: it composes the Supabase port, the real clock, and the structured
 * logger into the `deps` that `sweepStalledRuns` expects.
 */

import { logInfo, logWarn } from '~/lib/observability/logger';
import { createSupabaseStalledRunSweeperPort } from '~/lib/observability/stalled-run-repository';
import {
  sweepStalledRuns,
  type SweepStalledRunsInput,
  type SweepStalledRunsResult,
} from '~/lib/observability/stalled-run-sweeper';

export async function runStalledRunSweep(
  input: SweepStalledRunsInput = {},
): Promise<SweepStalledRunsResult> {
  return sweepStalledRuns(
    {
      port: createSupabaseStalledRunSweeperPort(),
      now: () => Date.now(),
      log: (event, fields) => {
        if (event.endsWith('_failed')) {
          logWarn(event, fields);
          return;
        }
        logInfo(event, fields);
      },
    },
    input,
  );
}
