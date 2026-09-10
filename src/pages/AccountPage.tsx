import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Header from '../components/Header';
import AccountMenu from '../components/AccountMenu';
import { labs } from '../content';
import { useAuth } from '../lib/auth';
import { useProgress } from '../lib/progressStore';

type Tab = 'signin' | 'signup';

export default function AccountPage() {
  const auth = useAuth();
  const { progress, sync, syncError } = useProgress();
  const navigate = useNavigate();
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
        navigate('/');
      } else {
        const needsConfirm = await auth.signUp(email.trim(), password);
        if (needsConfirm) setNotice('Account created. Check your inbox for a confirmation link, then sign in.');
        else navigate('/');
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
      <main className="mx-auto w-full max-w-md flex-1 overflow-y-auto px-4 py-10">
        {!auth.enabled ? (
          <section className="rounded-lg border border-border bg-surface p-6">
            <h1 className="display text-3xl text-fg-bright">Accounts are off</h1>
            <p className="mt-2 text-sm text-muted">
              This copy of NetLab runs in guest mode: progress stays in this browser. To enable accounts, the site operator creates a Supabase project and sets <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>. See the README.
            </p>
            <Link to="/" className="mt-4 inline-block text-accent hover:underline">
              Back to the labs
            </Link>
          </section>
        ) : auth.loading ? (
          <p className="text-muted">Loading…</p>
        ) : auth.user ? (
          <section className="rounded-lg border border-border bg-surface p-6">
            <h1 className="display text-3xl text-fg-bright">Your account</h1>
            <p className="mt-1 text-sm text-muted">{auth.user.email ?? auth.user.id}</p>
            <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-md border border-border p-3">
                <dt className="text-xs uppercase tracking-wide text-muted">Labs passed</dt>
                <dd className="mt-1 text-2xl text-fg-bright">
                  {passed}
                  <span className="text-sm text-muted"> / {labs.length}</span>
                </dd>
              </div>
              <div className="rounded-md border border-border p-3">
                <dt className="text-xs uppercase tracking-wide text-muted">Stars</dt>
                <dd className="mt-1 text-2xl text-fg-bright">
                  {stars}
                  <span className="text-sm text-muted"> / {labs.length * 3}</span>
                </dd>
              </div>
            </dl>
            <p className="mt-4 text-sm text-muted">
              {sync === 'synced' && 'Progress is saved to your account and follows you to any device.'}
              {sync === 'syncing' && 'Syncing progress…'}
              {sync === 'error' && <span className="text-danger">Sync failed: {syncError}</span>}
              {sync === 'local' && 'Progress is stored on this device.'}
            </p>
            <div className="mt-6 flex gap-3">
              <Link to="/" className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-bg hover:opacity-90">
                Back to the labs
              </Link>
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-fg"
                onClick={() => auth.signOut().then(() => navigate('/'))}
              >
                Sign out
              </button>
            </div>
          </section>
        ) : (
          <section className="rounded-lg border border-border bg-surface p-6">
            <div className="flex gap-1 rounded-md bg-surface-2 p-1 text-sm">
              {(['signin', 'signup'] as Tab[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`flex-1 rounded px-3 py-1.5 ${tab === t ? 'bg-surface text-fg-bright' : 'text-muted hover:text-fg'}`}
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
            <h1 className="display mt-5 text-3xl text-fg-bright">{tab === 'signin' ? 'Welcome back' : 'Keep your progress'}</h1>
            <p className="mt-1 text-sm text-muted">
              {tab === 'signin' ? 'Sign in to pick up where you left off on any device.' : 'A free account stores your scores and stars so you can continue from any device. Anything you passed as a guest on this device is kept.'}
            </p>
            <form onSubmit={submit} className="mt-5 flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-xs text-muted">
                Email
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg-bright outline-none focus:border-accent"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted">
                Password
                <input
                  type="password"
                  required
                  minLength={8}
                  autoComplete={tab === 'signin' ? 'current-password' : 'new-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg-bright outline-none focus:border-accent"
                />
              </label>
              {error && <p className="text-sm text-danger">{error}</p>}
              {notice && <p className="text-sm text-success">{notice}</p>}
              <button type="submit" disabled={busy} className="mt-1 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-bg hover:opacity-90 disabled:opacity-50">
                {busy ? 'Please wait…' : tab === 'signin' ? 'Sign in' : 'Create account'}
              </button>
            </form>
            <div className="my-4 flex items-center gap-3 text-xs text-muted">
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>
            <button type="button" onClick={github} className="w-full rounded-md border border-border px-3 py-2 text-sm text-fg hover:border-fg">
              Continue with GitHub
            </button>
            <p className="mt-4 text-xs text-muted">
              No account needed to practise:{' '}
              <Link to="/" className="text-accent hover:underline">
                continue as a guest
              </Link>
              .
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
