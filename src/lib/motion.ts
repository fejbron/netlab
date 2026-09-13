import { useEffect, useRef, useState } from 'react';

/**
 * True when the visitor has asked their system for less movement. Every animation on the
 * home page checks this and shows its finished state instead of playing.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => (typeof window === 'undefined' ? false : (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)));
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return reduced;
}

/** Is any part of the element inside the window right now? */
function onScreenNow(el: Element): boolean {
  const r = el.getBoundingClientRect();
  const h = window.innerHeight || document.documentElement.clientHeight || 0;
  const w = window.innerWidth || document.documentElement.clientWidth || 0;
  return r.bottom > 0 && r.top < h && r.right > 0 && r.left < w;
}

/**
 * Reports true once the element has been seen, and never goes back.
 *
 * Anything already on screen when it mounts counts as seen straight away, measured
 * rather than observed: content must never sit invisible waiting for a callback that
 * some browsers, and anything rendering the page without a compositor, do not send.
 * The observer is only there to catch what is scrolled to later, and if it never reports
 * at all the element is revealed regardless.
 */
export function useInView<T extends HTMLElement>(enabled = true): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(!enabled);
  useEffect(() => {
    if (!enabled) {
      setSeen(true);
      return;
    }
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined' || onScreenNow(el)) {
      setSeen(true);
      return;
    }
    let reported = false;
    const io = new IntersectionObserver(
      (entries) => {
        reported = true;
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
    );
    io.observe(el);
    const failsafe = setTimeout(() => {
      if (!reported) setSeen(true);
    }, 1200);
    return () => {
      clearTimeout(failsafe);
      io.disconnect();
    };
  }, [enabled]);
  return [ref, seen];
}
