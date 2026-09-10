import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useProgress } from '../lib/progressStore';

/** Header widget: sign-in link, or the signed-in learner with a sync indicator. */
export default function AccountMenu() {
  const auth = useAuth();
  const { sync, syncError } = useProgress();
  if (!auth.enabled) return null;
  if (auth.loading) return <span className="text-xs text-muted">…</span>;
  if (!auth.user)
    return (
      <Link to="/account" className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:text-fg">
        Sign in
      </Link>
    );
  const dot = sync === 'synced' ? 'bg-success' : sync === 'syncing' ? 'bg-warning' : sync === 'error' ? 'bg-danger' : 'bg-muted';
  const title = sync === 'synced' ? 'Progress synced to your account' : sync === 'syncing' ? 'Syncing…' : sync === 'error' ? `Sync failed: ${syncError}` : 'Progress on this device';
  return (
    <Link to="/account" className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted hover:text-fg" title={title}>
      <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
      <span className="max-w-40 truncate">{auth.user.email ?? 'Account'}</span>
    </Link>
  );
}
