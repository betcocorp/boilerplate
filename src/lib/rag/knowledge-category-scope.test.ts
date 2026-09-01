import { describe, expect, it } from 'vitest';

import { deriveKnowledgeCategoryFromS3Key } from '~/lib/rag/search';

describe('deriveKnowledgeCategoryFromS3Key (B0-780)', () => {
  it('extracts the folder segment right after v1-markdown-files/', () => {
    expect(
      deriveKnowledgeCategoryFromS3Key(
        'v1-markdown-files/vct/01_VCT_Stripping_Failures_and_Best_Practices.md',
      ),
    ).toBe('vct');
    expect(
      deriveKnowledgeCategoryFromS3Key('v1-markdown-files/sportszone/daily wood gym floor care.md'),
    ).toBe('sportszone');
    expect(deriveKnowledgeCategoryFromS3Key('v1-markdown-files/restroom/some-doc.md')).toBe(
      'restroom',
    );
    expect(deriveKnowledgeCategoryFromS3Key('v1-markdown-files/dilution-control/doc.md')).toBe(
      'dilution-control',
    );
  });

  it('handles a nested key (only the first segment after the marker is the category)', () => {
    expect(deriveKnowledgeCategoryFromS3Key('v1-markdown-files/vct/nested/dir/doc.md')).toBe('vct');
  });

  it('returns null for null, empty, or a key without the v1-markdown-files/ marker', () => {
    expect(deriveKnowledgeCategoryFromS3Key(null)).toBeNull();
    expect(deriveKnowledgeCategoryFromS3Key('')).toBeNull();
    expect(deriveKnowledgeCategoryFromS3Key('labels/betco/67804_touch-up.md')).toBeNull();
  });
});
