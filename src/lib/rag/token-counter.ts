/**
 * Token counting utilities for RAG chunks.
 * B0-279: Token-aware chunking with proper estimation.
 *
 * Token estimation is based on empirical testing with OpenAI's gpt-4o tokenizer.
 * The database side uses ceil(length / 3.0) as a conservative estimate.
 * This module provides utilities for validation and monitoring.
 */

/**
 * Minimum tokens per chunk. Chunks smaller than this should be:
 * - Combined with neighbors, or
 * - Skipped if orphaned
 */
export const MIN_CHUNK_TOKENS = 40;

/**
 * Maximum tokens per chunk. Chunks larger than this should be:
 * - Split into smaller pieces, or
 * - Flagged for manual review
 */
export const MAX_CHUNK_TOKENS = 1200;

/**
 * Character-based budget estimate for ~1200 tokens
 * Used for initial chunking before exact token counting.
 * Empirical formula: gpt-4o uses ~3.3 chars per token
 * Conservative: 1200 tokens = ~4000 chars (using 3.3 ratio)
 */
export const SAFE_CHUNK_CHAR_BUDGET = 4000;

/**
 * Estimate tokens in text using character-based heuristic.
 * Formula: ceil(length / 3.3) where 3.3 is empirical avg chars per token for gpt-4o
 * Conservative estimate ensures chunks stay under MAX_CHUNK_TOKENS.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // 3.3 characters per token (empirical gpt-4o average)
  // Use 3.0 for conservative estimate (safer upper bound)
  return Math.max(1, Math.ceil(text.length / 3.0));
}

/**
 * Check if a chunk is within acceptable token bounds.
 * Returns 'ok', 'tiny', or 'oversized'.
 */
export function checkChunkSize(tokenCount: number): 'ok' | 'tiny' | 'oversized' {
  if (tokenCount < MIN_CHUNK_TOKENS) return 'tiny';
  if (tokenCount > MAX_CHUNK_TOKENS) return 'oversized';
  return 'ok';
}

/**
 * Validate a chunk's token count and return status with message.
 */
export function validateChunkTokens(tokenCount: number, chunkText?: string): {
  status: 'ok' | 'tiny' | 'oversized';
  message: string;
} {
  const status = checkChunkSize(tokenCount);

  switch (status) {
    case 'tiny':
      return {
        status,
        message: `Chunk too small (${tokenCount} tokens < ${MIN_CHUNK_TOKENS} minimum)${chunkText ? ` - consider merging with adjacent chunks` : ''}`,
      };
    case 'oversized':
      return {
        status,
        message: `Chunk too large (${tokenCount} tokens > ${MAX_CHUNK_TOKENS} maximum)${chunkText ? ` - consider splitting further` : ''}`,
      };
    case 'ok':
      return {
        status,
        message: `Chunk size OK (${tokenCount} tokens)`,
      };
  }
}
