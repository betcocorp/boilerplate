import { CrossReferenceLookupSkeleton } from '../CrossReferenceSkeletons';

// The header + tabs live in the segment layout, so this fallback only covers the tab body.
export default function Loading() {
  return <CrossReferenceLookupSkeleton />;
}
