'use client';

import { Loader2, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import type { AnalyzeTestItemPayload } from '~/app/(authenticated)/admin/tests/[testId]/items/[itemId]/actions';
import { analyzeTestItem } from '~/app/(authenticated)/admin/tests/[testId]/items/[itemId]/actions';
import { Button } from '~/components/ui/button';

type ItemAIReviewButtonProps = {
  payload: AnalyzeTestItemPayload;
};

export function ItemAIReviewButton({ payload }: ItemAIReviewButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      await analyzeTestItem(payload);
      toast.success('AI recommendations saved');
      router.refresh();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'AI analysis failed.';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      disabled={loading}
      onClick={handleClick}
      size="sm"
      title="AI review — top 3 ways to make this item pass"
      variant="outline"
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Sparkles className="h-4 w-4" />
      )}
    </Button>
  );
}
