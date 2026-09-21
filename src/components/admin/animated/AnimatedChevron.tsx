import { ChevronDownIcon } from 'lucide-react';

export default function AnimatedChevron({ isOpen }: { isOpen: boolean }) {
  return (
    <ChevronDownIcon
      aria-hidden
      className={`size-4 shrink-0 transition-transform duration-300 ${isOpen ? 'rotate-180' : ''}`}
    />
  );
}
