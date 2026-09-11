import { Link, NavLink } from 'react-router-dom';
import type { ReactNode } from 'react';
import Icon, { NF } from './Icon';
import { paths, pathUrl } from '../content';
import { useAuth } from '../lib/auth';

export default function Header({ children }: { children?: ReactNode }) {
  const auth = useAuth();
  const nav = 'rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors';
  const cls = ({ isActive }: { isActive: boolean }) => `${nav} ${isActive ? 'bg-surface-2 text-fg-bright' : 'text-muted hover:text-fg'}`;
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-4 border-b border-border/80 bg-bg/80 px-4 backdrop-blur-md">
      <Link to="/" className="display flex items-center gap-2 text-[17px] leading-none text-fg-bright">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-bg">
          <Icon g={NF.terminal} className="text-[13px]" />
        </span>
        <span>
          net<span className="text-accent">lab</span>
        </span>
      </Link>
      <nav className="hidden items-center gap-0.5 sm:flex" aria-label="Main">
        {paths.map((p) => (
          <NavLink key={p.id} to={pathUrl(p.id)} end className={cls}>
            {p.shortTitle}
          </NavLink>
        ))}
        {auth.enabled && (
          <NavLink to="/leaderboard" className={cls}>
            Leaderboard
          </NavLink>
        )}
      </nav>
      <div className="ml-auto flex items-center gap-2 text-sm">{children}</div>
    </header>
  );
}
