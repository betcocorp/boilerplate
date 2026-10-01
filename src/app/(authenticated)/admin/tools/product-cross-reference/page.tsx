import { redirect } from 'next/navigation';

// B0-consolidation: the product cross-reference tester moved into the unified
// /admin/tools/cross-reference area (Lookup & mappings tab). Preserve this path as a
// permanent redirect so existing bookmarks / links (incl. the ?xrefQ / ?xrefPage
// mapping-browser deep links) keep working.
type PageProps = {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

function readParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export default async function LegacyProductCrossReferenceRedirect({ searchParams }: PageProps) {
  const resolved = await searchParams;
  const params = new URLSearchParams();
  const xrefQ = readParam(resolved.xrefQ).trim();
  const xrefPage = readParam(resolved.xrefPage).trim();
  if (xrefQ) params.set('xrefQ', xrefQ);
  if (xrefPage) params.set('xrefPage', xrefPage);
  const query = params.toString();

  redirect(`/admin/tools/cross-reference/lookup${query ? `?${query}` : ''}`);
}
