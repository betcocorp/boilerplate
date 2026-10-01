// Token counting utilities for chunk remediation (B0-279)
// Character-based token estimation for migration/auditing
// TODO: Upgrade to js-tiktoken for accurate OpenAI token counts after bundle review

/**
 * Count tokens in text using character-based estimation
 * 1 token ≈ 4 characters (empirical average for English text)
 * For production use, integrate js-tiktoken or OpenAI SDK
 */
export function countTokens(text: string): number {
  if (!text || !text.trim()) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens without full encoding (faster, less accurate)
 * Used for quick filtering before full token count
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Check if chunk is too small (<40 tokens)
 */
export function isTinyChunk(text: string, minTokens = 40): boolean {
  return countTokens(text) < minTokens;
}

/**
 * Check if chunk is too large (>1200 tokens)
 */
export function isOversizedChunk(text: string, maxTokens = 1200): boolean {
  return countTokens(text) > maxTokens;
}

/**
 * Combine tiny chunks with their neighbors to meet minimum token threshold
 */
export function remediateTinyChunks(
  chunks: { text: string; [key: string]: any }[],
  minTokens = 40
): { text: string; [key: string]: any }[] {
  if (chunks.length === 0) return chunks;

  const remediated: typeof chunks = [];
  let buffer = { ...chunks[0] };
  let bufferText = chunks[0].text;

  for (let i = 1; i < chunks.length; i++) {
    const currentTokens = countTokens(bufferText);

    if (currentTokens < minTokens) {
      // Combine with next chunk
      bufferText += '\n\n' + chunks[i].text;
      buffer.text = bufferText;
    } else {
      // Push current buffer and start new one
      remediated.push(buffer);
      buffer = { ...chunks[i] };
      bufferText = chunks[i].text;
    }
  }

  // Don't forget the last buffer
  if (bufferText.trim()) {
    buffer.text = bufferText;
    remediated.push(buffer);
  }

  return remediated;
}

/**
 * Split oversized chunks (>1200 tokens) into smaller pieces
 * Splits on sentence boundaries when possible
 */
export function remediateOversizedChunks(
  chunks: { text: string; [key: string]: any }[],
  maxTokens = 1200,
  targetTokens = 600 // Target size for splits
): { text: string; [key: string]: any }[] {
  const remediated: typeof chunks = [];

  for (const chunk of chunks) {
    if (!isOversizedChunk(chunk.text, maxTokens)) {
      remediated.push(chunk);
      continue;
    }

    // Split on sentence boundaries
    const sentences = chunk.text.match(/[^.!?]+[.!?]+/g) || [chunk.text];
    let currentChunk = { ...chunk };
    let currentText = '';

    for (const sentence of sentences) {
      const testText = currentText + (currentText ? ' ' : '') + sentence;
      const testTokens = countTokens(testText);

      if (testTokens > targetTokens && currentText) {
        // Push current chunk and start new one
        currentChunk.text = currentText.trim();
        remediated.push(currentChunk);
        currentChunk = { ...chunk };
        currentText = sentence.trim();
      } else {
        currentText = testText;
      }
    }

    // Push final chunk if non-empty
    if (currentText.trim()) {
      currentChunk.text = currentText.trim();
      remediated.push(currentChunk);
    }
  }

  return remediated;
}

/**
 * Audit chunks for size violations
 * Returns summary of issues found
 */
export function auditChunkSizes(
  chunks: { text: string }[],
  minTokens = 40,
  maxTokens = 1200
) {
  const issues = {
    tiny: [] as number[],
    oversized: [] as number[],
    valid: 0,
  };

  for (let i = 0; i < chunks.length; i++) {
    const tokens = countTokens(chunks[i].text);
    if (tokens < minTokens) {
      issues.tiny.push(i);
    } else if (tokens > maxTokens) {
      issues.oversized.push(i);
    } else {
      issues.valid++;
    }
  }

  return issues;
}
