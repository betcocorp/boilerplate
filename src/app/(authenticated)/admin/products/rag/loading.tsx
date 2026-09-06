import { Search } from 'lucide-react';

import { CardGridSkeleton } from '~/components/admin/skeletons';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';

export default function Loading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-col gap-3">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
              RAG Similarity Search
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-slate-950">
              Search the RAG product line corpus semantically
            </h1>
            <p className="max-w-3xl text-base leading-7 text-slate-600">
              Retrieval is one document per legacy product line. Chunks include
              rolled-up size variants; filters only target product line keys.
            </p>
          </div>

          <div className="mt-8 grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(140px,0.5fr)_minmax(220px,0.8fr)_120px_160px_auto]">
            <div className="flex flex-col gap-2">
              <Label className="text-sm font-medium text-slate-700">Query</Label>
              <Input
                className="h-12 rounded-2xl px-4"
                disabled
                placeholder="Ask something like: peroxide bathroom disinfectant"
                type="search"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label className="text-sm font-medium text-slate-700">Scope</Label>
              <Select defaultValue="all" disabled>
                <SelectTrigger className="h-12 w-full rounded-2xl px-4">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="products">Products</SelectItem>
                  <SelectItem value="sds">SDS</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label className="text-sm font-medium text-slate-700">
                Product line key
              </Label>
              <Input
                className="h-12 rounded-2xl px-4"
                disabled
                placeholder="Optional product line key"
                type="text"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label className="text-sm font-medium text-slate-700">Limit</Label>
              <Input
                className="h-12 rounded-2xl px-4"
                disabled
                placeholder="8"
                type="number"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label className="text-sm font-medium text-slate-700">
                Similarity threshold
              </Label>
              <Input
                className="h-12 rounded-2xl px-4"
                disabled
                placeholder="0.65 or 65"
                type="text"
              />
            </div>
            <Button
              className="mt-auto h-12 rounded-2xl px-6 font-semibold opacity-80"
              disabled
              type="button"
            >
              <Search className="size-4" />
            </Button>
          </div>
          <p className="mt-3 text-sm text-slate-500">
            Minimum similarity is optional. Enter a decimal like `0.65` or a whole
            percent like `65`.
          </p>
        </section>

        <section className="flex items-center justify-between">
          <div className="text-sm text-slate-600">Loading semantic search results...</div>
          <div className="text-sm text-slate-600">Preparing similarity range...</div>
        </section>

        <CardGridSkeleton
          actions={2}
          badges={3}
          cardClassName="rounded-3xl p-6"
          columnsClassName="lg:grid-cols-2"
          count={6}
          lines={3}
          metaTags={3}
          subtitle
        />
      </main>
    </div>
  );
}
