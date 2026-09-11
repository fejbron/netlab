import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { accountUrl, readAuthCallback, type AuthCallback } from './authCallback';

/**
 * Optional backend. When VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set,
 * learners can create accounts and their progress is stored in Supabase.
 * Without them the app runs in guest mode with localStorage only.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * Read the address bar before the client below starts, because a successful
 * confirmation is stripped from it as soon as supabase-js has taken the tokens.
 */
export const authCallback: AuthCallback = typeof window === 'undefined' ? { kind: 'none' } : readAuthCallback(window.location.href);

export const supabase: SupabaseClient | null = url && anonKey ? createClient(url, anonKey) : null;

export const accountsEnabled = supabase !== null;

/**
 * Where Supabase should send the learner back to. It must match a URL allowed
 * under Authentication > URL Configuration, so a deployment whose own origin is
 * not on that list (a preview build, or www against the bare domain) can set
 * VITE_SITE_URL to the address that is.
 */
export function siteUrl(): string {
  const configured = import.meta.env.VITE_SITE_URL as string | undefined;
  if (configured) return configured.replace(/\/+$/, '');
  return typeof window === 'undefined' ? '' : window.location.origin;
}

/** The confirmation link's destination: the account page, remembering where the learner was going. */
export function authRedirectTo(next?: string | null): string {
  return accountUrl(siteUrl(), next);
}
