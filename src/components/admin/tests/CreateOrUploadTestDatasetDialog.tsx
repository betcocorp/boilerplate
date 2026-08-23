'use client';

import { useState } from 'react';

import { uploadTestCsvAction } from '~/app/(authenticated)/admin/tests/actions';
import { TestIntendedAgentCombobox } from '~/components/admin/tests/TestIntendedAgentCombobox';
import { TestTemplateDownload } from '~/components/admin/tests/TestTemplateDownload';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { V1_AGENT_REGISTRY } from '~/lib/agents/agent-registry';
import { TEST_TEMPLATE_COLUMNS } from '~/lib/tests/template';

type CreateOrUploadTestDatasetDialogProps = {
  /** Where to redirect after creating (typically /admin/tests). */
  returnPath?: string;
};

export function CreateOrUploadTestDatasetDialog({
  returnPath = '/admin/tests',
}: CreateOrUploadTestDatasetDialogProps) {
  const [open, setOpen] = useState(false);

  const intendedAgentFormOptions = V1_AGENT_REGISTRY.map((agent) => ({
    id: agent.id,
    label: agent.label,
    description: agent.description,
  }));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm">
          Create or upload dataset
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create or upload test dataset</DialogTitle>
          <DialogDescription>
            CSV is optional. Without a file, a ready test set is created with no
            rows (source{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
              ad-hoc
            </code>
            ); add prompts from the detail page. With a CSV, rows are imported
            as before.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 overflow-y-auto py-4">
          {/* Form section */}
          <form
            action={uploadTestCsvAction}
            className="grid gap-4 sm:grid-cols-2"
          >
            <input name="returnPath" type="hidden" value={returnPath} />

            <div className="flex flex-col gap-2">
              <Label
                className="text-sm text-slate-700"
                htmlFor="test-name-input"
              >
                Test name
              </Label>
              <Input
                id="test-name-input"
                name="name"
                placeholder="Product catalog specialist set"
                type="text"
              />
              <p className="text-xs text-slate-500">
                Required when creating without a CSV; optional when uploading
                (defaults to the file name).
              </p>
            </div>

            <TestIntendedAgentCombobox
              agents={intendedAgentFormOptions}
              id="test-intended-agent"
              label="Intended agent"
            />

            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label
                className="text-sm text-slate-700"
                htmlFor="test-dataset-input"
              >
                CSV file{' '}
                <span className="font-normal text-slate-500">(optional)</span>
              </Label>
              <Input
                accept=".csv,text/csv"
                id="test-dataset-input"
                name="dataset"
                type="file"
              />
            </div>

            <div className="sm:col-span-2">
              <Button type="submit" className="w-full sm:w-auto">
                Create / upload dataset
              </Button>
            </div>
          </form>

          {/* Template guidance section */}
          <div className="border-t border-slate-200 pt-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-slate-900">
                  Not sure about the format? Start from the template
                </h3>
                <p className="mt-1 max-w-3xl text-sm text-slate-600">
                  Download the CSV template, replace the single example row with
                  your own prompts (one per row), and upload it above. Only{' '}
                  <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
                    question
                  </code>{' '}
                  is required — every other column is optional and can be left
                  blank. Keep the header row; the example row is just guidance
                  and should be replaced.
                </p>
              </div>
              <TestTemplateDownload />
            </div>

            {/* Column reference */}
            <details className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <summary className="cursor-pointer text-sm font-medium text-slate-800">
                Column reference
              </summary>
              <div className="mt-3 min-w-0 overflow-x-auto">
                <Table className="w-full">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Column</TableHead>
                      <TableHead>Required</TableHead>
                      <TableHead>What it&rsquo;s for</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {TEST_TEMPLATE_COLUMNS.map((column) => (
                      <TableRow key={column.name}>
                        <TableCell className="whitespace-nowrap font-mono text-xs text-slate-700">
                          {column.name}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-slate-600">
                          {column.required ? 'Required' : 'Optional'}
                        </TableCell>
                        <TableCell className="w-64 text-sm text-slate-600">
                          {column.help}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </details>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
