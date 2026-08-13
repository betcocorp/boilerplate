import { redirect } from 'next/navigation';

// The consolidated area has no landing view of its own — default to the Lookup tab so
// the active-tab highlight (derived from the pathname) always resolves.
export default function CrossReferenceIndexPage() {
  redirect('/admin/tools/cross-reference/lookup');
}
