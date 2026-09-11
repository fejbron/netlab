import { Link } from 'react-router-dom';
import Icon, { NF } from './Icon';
import { useAuth } from '../lib/auth';
import { useProgress } from '../lib/progressStore';

/** Header widget: sign-in button, or the signed-in learner with a sync indicator. */
export default function AccountMenu() {
  const auth = useAuth();
  const { sync, syncError } = useProgress();
  if (!auth.enabled) return null;
  if (auth.loading) return <span className="text-xs text-muted">…</span>;
  if (!auth.user)
    return (
      <Link to="/account" className="btn btn-primary btn-sm">
        <Icon g={NF.signIn} />
        Sign in
      </Link>
    );
  const dot = sync === 'synced' ? 'bg-success' : sync === 'syncing' ? 'bg-warning animate-pulse' : sync === 'error' ? 'bg-danger' : 'bg-muted';
  const title = sync === 'synced' ? 'Progress synced to your account' : sync === 'syncing' ? 'Syncing…' : sync === 'error' ? `Sync failed: ${syncError}` : 'Progress on this device';
  return (
    <Link to="/account" className="btn btn-ghost btn-sm" title={title}>
      <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
      <Icon g={NF.user} className="text-muted" />
      <span className="max-w-36 truncate font-normal">{auth.user.email ?? 'Account'}</span>
    </Link>
  );
}
