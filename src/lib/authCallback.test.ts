import { describe, expect, it } from 'vitest';
import { accountUrl, callbackMessage, canResend, readAuthCallback, safeNext } from './authCallback';

const site = 'https://netlab.example';

describe('reading the URL Supabase sends learners back to', () => {
  it('sees nothing on an ordinary visit', () => {
    expect(readAuthCallback('https://netlab.example/account')).toEqual({ kind: 'none' });
    expect(readAuthCallback('https://netlab.example/account?next=%2Flab%2Fip-01')).toEqual({ kind: 'none' });
    // A URL the browser would never produce must not throw.
    expect(readAuthCallback('not a url')).toEqual({ kind: 'none' });
  });

  it('reads a confirmation from the fragment and a PKCE code from the query', () => {
    expect(readAuthCallback('https://netlab.example/account#access_token=abc&refresh_token=def&type=signup')).toEqual({ kind: 'confirmed', type: 'signup' });
    expect(readAuthCallback('https://netlab.example/account?code=pkce-code')).toEqual({ kind: 'confirmed', type: null });
  });

  it('reads an expired link, which supabase-js leaves in the fragment', () => {
    const c = readAuthCallback('https://netlab.example/account#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    expect(c).toEqual({ kind: 'error', code: 'otp_expired', description: 'Email link is invalid or has expired' });
    // "+" is a space, not a plus, and the learner is told how to recover.
    expect(callbackMessage(c as never)).toContain('expired');
    expect(canResend(c as never)).toBe(true);
  });

  it('reads an error from the query as well, and falls back to Supabase wording', () => {
    const c = readAuthCallback('https://netlab.example/account?error=server_error&error_description=Database%20error');
    expect(c).toEqual({ kind: 'error', code: 'server_error', description: 'Database error' });
    expect(callbackMessage(c as never)).toBe('Database error');
  });

  it('still reports an error that arrives with no description', () => {
    const c = readAuthCallback('https://netlab.example/account#error_code=otp_expired');
    expect(c.kind).toBe('error');
    expect(callbackMessage(c as never)).not.toBe('');
  });

  it('prefers the error over any token in the same URL', () => {
    expect(readAuthCallback('https://netlab.example/account#access_token=abc&error_code=otp_expired').kind).toBe('error');
  });
});

describe('where the confirmation link comes back to', () => {
  it('returns the learner to the page they were headed for', () => {
    expect(accountUrl(site, '/lab/ip-01')).toBe('https://netlab.example/account?next=%2Flab%2Fip-01');
    expect(accountUrl(site, '/')).toBe('https://netlab.example/account');
    expect(accountUrl(site, null)).toBe('https://netlab.example/account');
  });

  it('ignores a trailing slash on the configured site URL', () => {
    expect(accountUrl('https://netlab.example/', '/leaderboard')).toBe('https://netlab.example/account?next=%2Fleaderboard');
  });

  it('refuses to bounce anyone off-site', () => {
    for (const hostile of ['//evil.example', 'https://evil.example', 'javascript:alert(1)', '']) expect(safeNext(hostile)).toBe('/');
    expect(accountUrl(site, '//evil.example')).toBe('https://netlab.example/account');
    expect(safeNext('/lab/ip-01')).toBe('/lab/ip-01');
  });
});
