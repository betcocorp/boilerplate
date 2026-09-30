/** One tool call's record in an agent loop's trace, for logging/debugging/UI display. */
export type ToolTraceEntry = {
  toolName: string;
  callId: string;
  argumentsPreview: string;
  outputPreview: string;
  ok: boolean;
  durationMs: number;
};
