import { CrossReferenceLookupSkeleton } from './CrossReferenceSkeletons';

// Segment-level fallback: the index route redirects to /lookup, so show the lookup shape
// rather than letting the parent /admin/tools grid skeleton flash.
export default function Loading() {
  return <CrossReferenceLookupSkeleton />;
}
