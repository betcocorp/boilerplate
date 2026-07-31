import { CrossReferenceMappingsTable } from '~/components/admin/CrossReferenceMappingsTable';
import { ProductCrossReferenceTester } from '~/components/admin/ProductCrossReferenceTester';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card';

export const metadata = {
  title: 'Cross-reference · Lookup & mappings | Betco BEX Admin',
  description:
    'Test lookup_cross_reference against legacy competitor mapping (same logic as Bex agents) and browse the full 1:1 mappings.',
};

function readParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

type PageProps = {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default async function CrossReferenceLookupPage({ searchParams }: PageProps) {
  const resolved = await searchParams;
  const search = readParam(resolved.xrefQ).trim();
  const parsedPage = Number.parseInt(readParam(resolved.xrefPage) || '1', 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;

  return (
    <div className="space-y-6">
      <Card className="rounded-3xl border border-border/60 shadow-none">
        <CardHeader>
          <CardTitle>Lookup tester</CardTitle>
          <CardDescription>
            Exercise only the competitor → Betco mapping tool. Results mirror what{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">lookup_cross_reference</code>{' '}
            returns in chat—no other product tools are invoked.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ProductCrossReferenceTester />
        </CardContent>
      </Card>

      <CrossReferenceMappingsTable page={page} search={search} />
    </div>
  );
}
