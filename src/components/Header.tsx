import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

export default function Header({ children }: { children?: ReactNode }) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface px-4">
      <Link to="/" className="display text-2xl leading-none text-fg-bright">
        Net<span className="text-accent">Lab</span>
      </Link>
      <div className="flex items-center gap-3 text-sm">{children}</div>
    </header>
  );
}
