import type { ReactNode } from 'react';
import { useInView, usePrefersReducedMotion } from '../lib/motion';

/**
 * Lifts its children into place the first time they are scrolled to. Nothing is ever
 * hidden for good: the class that fades it in is the only thing being animated, so with
 * reduced motion asked for, or no observer available, the content simply appears.
 */
export default function Reveal({ children, delay = 0, className = '' }: { children: ReactNode; delay?: number; className?: string }) {
  const reduced = usePrefersReducedMotion();
  const [ref, seen] = useInView<HTMLDivElement>(!reduced);
  return (
    <div ref={ref} className={`reveal ${seen ? 'is-visible' : ''} ${className}`} style={reduced ? undefined : { transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}
