import { Boxes } from 'lucide-react';
import Link from 'next/link';

import { ToolDocumentation } from '~/components/admin/ToolDocumentation';
import { productSupportTools } from '~/lib/tools/definitions';

export const metadata = {
  title: 'All tools | Betco BEX Admin',
  description: 'Complete documentation for all 14 product-support tools with JSON schemas.',
};

export default function AllToolsPage() {
  return (
    <main className="min-w-0 p-4 sm:p-6">
      <div className="rounded-[2rem] border border-border/60 bg-background p-6 shadow-sm sm:p-8">
        <div className="mb-8">
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Boxes className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-muted-foreground">Tools</p>
              <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
                All tools
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                Complete documentation for all 14 product-support tools. Each tool is callable by
                Bex agents to answer customer questions. Expand each tool to view parameters,
                required fields, and the full JSON schema.
              </p>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-2 rounded-lg bg-muted/30 p-3 text-xs text-muted-foreground">
            <span className="font-semibold">Total tools:</span>
            <code className="rounded bg-muted px-2 py-1 font-mono">{productSupportTools.length}</code>
            <span className="ml-2">
              These tools are exposed to the AI model for tool use during product-support
              conversations.
            </span>
          </div>
        </div>

        <Link href="/admin/tools" className="inline-flex gap-2 text-sm text-primary hover:underline mb-6">
          <span>← Back to tools</span>
        </Link>

        <div className="space-y-3">
          {productSupportTools.map((tool, index) => (
            <div key={tool.type === 'function' ? tool.name : index}>
              <ToolDocumentation tool={tool} />
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
