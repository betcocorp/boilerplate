'use client';

import { Download } from 'lucide-react';
import { useCallback } from 'react';

import { Button } from '~/components/ui/button';
import { TEST_TEMPLATE_FILENAME, buildTestTemplateCsv } from '~/lib/tests/template';

export function TestTemplateDownload() {
  const downloadTemplate = useCallback(() => {
    const blob = new Blob([buildTestTemplateCsv()], {
      type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = TEST_TEMPLATE_FILENAME;
    anchor.click();
    URL.revokeObjectURL(url);
  }, []);

  return (
    <Button onClick={downloadTemplate} size="sm" type="button" variant="outline">
      <Download className="size-4" />
      Download CSV template
    </Button>
  );
}
