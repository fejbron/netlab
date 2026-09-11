import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import Header from '../components/Header';
import AccountMenu from '../components/AccountMenu';
import Icon, { NF } from '../components/Icon';
import { labs } from '../content';
import { useAuth } from '../lib/auth';
import { fetchProfile, updateProfile, type Profile } from '../lib/leaderboard';
import { useProgress } from '../lib/progressStore';

type Tab = 'signin' | 'signup';

/** Public name and leaderboard opt-out for the signed-in learner. */
function ProfileSettings({ userId, fallbackName }: { userId: string; fallbackName: string }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchProfile(userId)
      .then((p) => {
        if (cancelled) return;
        const resolved = p ?? { id: userId, displayName: fallbackName, showOnLeaderboard: true };
        setProfile(resolved);
        setName(resolved.displayName);
      })
      .catch((e: unknown) => {
        if (!cancelled) setMessage({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [userId, fallbackName]);

  async function save(patch: Partial<Pick<Profile, 'displayName' | 'showOnLeaderboard'>>) {
    setBusy(true);
    setMessage(null);
    try {
      await updateProfile(userId, patch);
      setProfile((p) => (p ? { ...p, ...patch } : p));
      setMessage({ kind: 'ok', text: 'Saved.' });
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!profile) return <p className="mt-5 text-xs text-muted">{message ? <span className="text-danger">{message.text}</span> : 'Loading profile…'}</p>;
  const trimmed = name.trim();
  const valid = trimmed.length >= 2 && trimmed.length <= 32;
  return (
    <div className="mt-6 border-t border-border pt-5">
      <h2 className="label text-muted">
        <Icon g={NF.trophy} className="mr-1.5 text-star" />
        Leaderboard
      </h2>
      <form
        className="mt-3 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && trimmed !== profile.displayName) void save({ displayName: trimmed });
        }}
      >
        <label className="flex flex-1 flex-col gap-1 text-xs text-muted">
          Display name (shown publicly)
          <input type="text" value={name} minLength={2} maxLength={32} onChange={(e) => setName(e.target.value)} className="input font-mono" />
        </label>
        <button type="submit" disabled={busy || !valid || trimmed === profile.displayName} className="btn btn-ghost">
          Save
        </button>
      </form>
      <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-muted">
        <input type="checkbox" checked={profile.showOnLeaderboard} disabled={busy} onChange={(e) => void save({ showOnLeaderboard: e.target.checked })} className="accent-accent" />
        Show me on the leaderboard
      </label>
      {message && <p className={`mt-2 text-xs ${message.kind === 'ok' ? 'text-success' : 'text-danger'}`}>{message.text}</p>}
      <Link to="/leaderboard" className="mt-3 inline-flex items-center gap-1 text-xs text-accent hover:underline">
        View the leaderboard
        <Icon g={NF.arrowRight} />
      </Link>
    </div>
  );
}

export default function AccountPage() {
  const auth = useAuth();
  const { progress, sync, syncError } = useProgress();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // Where to go after signing in: only same-site paths are honoured.
  const rawNext = params.get('next') ?? '/';
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';
  const [tab, setTab] = useState<Tab>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (tab === 'signin') {
        await auth.signIn(email.trim(), password);
        navigate(next);
      } else {
        const needsConfirm = await auth.signUp(email.trim(), password);
        if (needsConfirm) setNotice('Account created. Check your inbox for a confirmation link, then sign in.');
        else navigate(next);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function github() {
    setError(null);
    try {
      await auth.signInWithGitHub();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const passed = labs.filter((l) => progress[l.id]).length;
  const stars = labs.reduce((n, l) => n + (progress[l.id]?.stars ?? 0), 0);

  return (
    <div className="flex h-full flex-col">
      <Header>
        <AccountMenu />
      </Header>
      <main className="mx-auto w-full max-w-md flex-1 overflow-y-auto px-4 pb-16 pt-12">
        {!auth.enabled ? (
          <section className="card p-6">
            <h1 className="display text-2xl text-fg-bright">Accounts are off</h1>
            <p className="mt-2 text-sm leading-6 text-muted">
              This copy of NetLab runs in guest mode: progress stays in this browser. To enable accounts, the site operator creates a Supabase project and sets <code className="font-mono text-fg">VITE_SUPABASE_URL</code> and <code className="font-mono text-fg">VITE_SUPABASE_ANON_KEY</code>. See the README.
            </p>
            <Link to="/" className="btn btn-ghost mt-5">
              <Icon g={NF.arrowLeft} />
              Back to the labs
            </Link>
          </section>
        ) : auth.loading ? (
          <p className="text-muted">Loading…</p>
        ) : auth.user ? (
          <section className="card p-6">
            <p className="label text-accent">
              <Icon g={NF.user} className="mr-1.5" />
              Your account
            </p>
            <h1 className="mt-1 truncate font-mono text-lg text-fg-bright">{auth.user.email ?? auth.user.id}</h1>
            <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-xl bg-surface-2 p-3">
                <dt className="label text-muted">Labs passed</dt>
                <dd className="mt-1 font-mono text-2xl font-bold text-fg-bright">
                  {passed}
                  <span className="text-sm font-normal text-muted"> / {labs.length}</span>
                </dd>
              </div>
              <div className="rounded-xl bg-surface-2 p-3">
                <dt className="label text-muted">Stars</dt>
                <dd className="mt-1 font-mono text-2xl font-bold text-star">
                  <Icon g={NF.star} className="mr-1 text-lg" />
                  {stars}
                  <span className="text-sm font-normal text-muted"> / {labs.length * 3}</span>
                </dd>
              </div>
            </dl>
            <p className="mt-4 flex items-center gap-1.5 text-sm text-muted">
              {sync === 'synced' && (
                <>
                  <Icon g={NF.cloud} className="text-success" />
                  Progress is saved to your account and follows you to any device.
                </>
              )}
              {sync === 'syncing' && (
                <>
                  <Icon g={NF.cloudUp} className="text-warning" />
                  Syncing progress…
                </>
              )}
              {sync === 'error' && (
                <span className="text-danger">
                  <Icon g={NF.warning} className="mr-1.5" />
                  Sync failed: {syncError}
                </span>
              )}
              {sync === 'local' && (
                <>
                  <Icon g={NF.hdd} />
                  Progress is stored on this device.
                </>
              )}
            </p>
            <ProfileSettings userId={auth.user.id} fallbackName={auth.user.email?.split('@')[0] ?? 'learner'} />
            <div className="mt-6 flex gap-3">
              <Link to="/" className="btn btn-primary">
                <Icon g={NF.arrowLeft} />
                Back to the labs
              </Link>
              <button type="button" className="btn btn-ghost" onClick={() => auth.signOut().then(() => navigate('/'))}>
                <Icon g={NF.signOut} />
                Sign out
              </button>
            </div>
          </section>
        ) : (
          <section className="card p-6">
            <div className="flex gap-1 rounded-xl bg-surface-2 p-1 text-sm">
              {(['signin', 'signup'] as Tab[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`flex-1 rounded-lg px-3 py-1.5 font-medium transition-colors ${tab === t ? 'bg-surface-3 text-fg-bright' : 'text-muted hover:text-fg'}`}
                  onClick={() => {
                    setTab(t);
                    setError(null);
                    setNotice(null);
                  }}
                >
                  {t === 'signin' ? 'Sign in' : 'Create account'}
                </button>
              ))}
            </div>
            <h1 className="display mt-6 text-2xl text-fg-bright">{tab === 'signin' ? 'Welcome back' : 'Keep your progress'}</h1>
            <p className="mt-1 text-sm leading-6 text-muted">
              {tab === 'signin' ? 'Sign in to pick up where you left off on any device.' : 'A free account stores your scores and stars so you can continue from any device and appear on the leaderboard.'}
            </p>
            <form onSubmit={submit} className="mt-5 flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-xs text-muted">
                Email
                <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="input" />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted">
                Password
                <input type="password" required minLength={8} autoComplete={tab === 'signin' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} className="input" />
              </label>
              {error && (
                <p className="text-sm text-danger">
                  <Icon g={NF.warning} className="mr-1.5" />
                  {error}
                </p>
              )}
              {notice && (
                <p className="text-sm text-success">
                  <Icon g={NF.envelope} className="mr-1.5" />
                  {notice}
                </p>
              )}
              <button type="submit" disabled={busy} className="btn btn-primary mt-1 justify-center py-2.5">
                {busy ? 'Please wait…' : tab === 'signin' ? 'Sign in' : 'Create account'}
              </button>
            </form>
            <div className="my-4 flex items-center gap-3 text-xs text-muted">
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>
            <button type="button" onClick={github} className="btn btn-ghost w-full justify-center py-2.5">
              <Icon g={NF.github} />
              Continue with GitHub
            </button>
            <p className="mt-4 text-xs leading-5 text-muted">
              An account is required to run the labs. It only stores your scores, stars and display name.{' '}
              <Link to="/" className="text-accent hover:underline">
                Browse the lab list
              </Link>
              .
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
