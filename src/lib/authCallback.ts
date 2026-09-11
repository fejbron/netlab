/**
 * Coming back from a confirmation email or an OAuth provider.
 *
 * Supabase puts the outcome in the URL it sends the learner back to. A
 * successful implicit-flow confirmation arrives as `#access_token=…`, a PKCE
 * one as `?code=…`, and a failure as `#error=…&error_code=…`. supabase-js
 * consumes the two success shapes and strips them from the address bar, but on
 * a failure it returns early and leaves the fragment untouched, so without the
 * reading below a dead link just shows an empty sign-in form.
 *
 * The URL therefore has to be captured before the client starts (see
 * lib/supabase.ts) and these functions are pure so they can be tested.
 */
export type AuthCallback =
  /** Not a return from Supabase. */
  | { kind: 'none' }
  /** The link worked; a session should follow. `type` is 'signup', 'recovery', 'invite' or 'magiclink' when stated. */
  | { kind: 'confirmed'; type: string | null }
  /** The link was refused. `code` is Supabase's `error_code`, e.g. 'otp_expired'. */
  | { kind: 'error'; code: string | null; description: string };

/** Parameters live in the fragment for the implicit flow and in the query for PKCE, so read both. */
function params(url: string): URLSearchParams {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return new URLSearchParams();
  }
  const all = new URLSearchParams(parsed.search);
  for (const [k, v] of new URLSearchParams(parsed.hash.replace(/^#/, ''))) all.set(k, v);
  return all;
}

export function readAuthCallback(url: string): AuthCallback {
  const p = params(url);
  const error = p.get('error');
  const code = p.get('error_code');
  const description = p.get('error_description');
  if (error || code || description) return { kind: 'error', code: code ?? error ?? null, description: description ?? '' };
  if (p.get('access_token') || p.get('code')) return { kind: 'confirmed', type: p.get('type') };
  return { kind: 'none' };
}

/** What to tell the learner. Supabase's own wording is used when we have nothing better. */
export function callbackMessage(c: Extract<AuthCallback, { kind: 'error' }>): string {
  switch (c.code) {
    case 'otp_expired':
      return 'That confirmation link has expired. Links are only good for a short while, so ask for a new one below and open the newest email.';
    case 'access_denied':
      return 'That confirmation link is no longer valid. It may have expired or already been used. Ask for a new one below, or sign in if the account is already confirmed.';
    case 'signup_disabled':
      return 'This site is not accepting new accounts at the moment.';
    case 'provider_email_needs_verification':
      return 'Confirm your email address with the provider you signed in through, then try again.';
    case 'validation_failed':
      return c.description || 'The sign-in provider rejected the request. The site operator needs to check the redirect URLs allowed in Supabase.';
    default:
      return c.description || 'Sign-in failed. Try again, or ask for a new confirmation link below.';
  }
}

/** True when a new confirmation email would fix it. */
export function canResend(c: Extract<AuthCallback, { kind: 'error' }>): boolean {
  return c.code === 'otp_expired' || c.code === 'access_denied' || c.code === null;
}

/** Only same-site paths are honoured, so a crafted link cannot bounce a learner off-site. */
export function safeNext(next: string | null | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

/** The account page on `site`, carrying where the learner was headed. Pure. */
export function accountUrl(site: string, next?: string | null): string {
  const base = site.replace(/\/+$/, '');
  const path = safeNext(next);
  return path === '/' ? `${base}/account` : `${base}/account?next=${encodeURIComponent(path)}`;
}

/**
 * Where the learner was headed, kept across the trip through the mailbox.
 *
 * It deliberately does not travel in the redirect URL. Supabase only honours
 * redirect targets that match its allow-list and silently falls back to the
 * project's Site URL otherwise, so every extra query parameter is one more
 * pattern the operator has to get right. Keeping the destination here means
 * the redirect is always the bare account page.
 *
 * localStorage rather than sessionStorage because the confirmation email is
 * usually opened in a new tab.
 */
const NEXT_KEY = 'netlab-auth-next';

export function rememberNext(next: string | null | undefined, store: Storage | undefined = globalThis.localStorage): void {
  const path = safeNext(next);
  try {
    if (path === '/') store?.removeItem(NEXT_KEY);
    else store?.setItem(NEXT_KEY, path);
  } catch {
    // Private browsing can refuse storage; losing the destination is not worth failing the sign-up over.
  }
}

/** Read the remembered destination and forget it, so it cannot fire twice. */
export function takeRememberedNext(store: Storage | undefined = globalThis.localStorage): string {
  try {
    const stored = store?.getItem(NEXT_KEY) ?? null;
    store?.removeItem(NEXT_KEY);
    return safeNext(stored);
  } catch {
    return '/';
  }
}

/**
 * Supabase answers a sign-in through a provider that is switched off with
 * "Unsupported provider: provider is not enabled", which reads like a bug in
 * the site rather than a setting nobody has filled in yet.
 */
export function oauthErrorMessage(raw: string, provider = 'GitHub'): string {
  if (/provider is not enabled|unsupported provider/i.test(raw)) return `${provider} sign-in is not enabled on this site yet. Use an email address and password instead.`;
  return raw;
}
