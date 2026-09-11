import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { User } from '@supabase/supabase-js';
import { accountsEnabled, authRedirectTo, supabase } from './supabase';

export interface AuthState {
  /** False when no Supabase project is configured: guest mode only. */
  enabled: boolean;
  /** True until the stored session (if any) has been read. */
  loading: boolean;
  user: User | null;
  signIn(email: string, password: string): Promise<void>;
  /**
   * Resolves with true when the account needs email confirmation before it can sign in.
   * `next` is where the learner was headed; the confirmation link returns them there.
   */
  signUp(email: string, password: string, next?: string | null): Promise<boolean>;
  /** Send another confirmation email, for a link that expired before it was opened. */
  resendConfirmation(email: string, next?: string | null): Promise<void>;
  signInWithGitHub(next?: string | null): Promise<void>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

function fail(message: string): never {
  throw new Error(message);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(accountsEnabled);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setUser(data.session?.user ?? null);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const value: AuthState = {
    enabled: accountsEnabled,
    loading,
    user,
    async signIn(email, password) {
      if (!supabase) fail('Accounts are not enabled on this site.');
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) fail(error.message);
    },
    async signUp(email, password, next) {
      if (!supabase) fail('Accounts are not enabled on this site.');
      const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: authRedirectTo(next) } });
      if (error) fail(error.message);
      return data.session === null;
    },
    async resendConfirmation(email, next) {
      if (!supabase) fail('Accounts are not enabled on this site.');
      const { error } = await supabase.auth.resend({ type: 'signup', email, options: { emailRedirectTo: authRedirectTo(next) } });
      if (error) fail(error.message);
    },
    async signInWithGitHub(next) {
      if (!supabase) fail('Accounts are not enabled on this site.');
      const { error } = await supabase.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: authRedirectTo(next) } });
      if (error) fail(error.message);
    },
    async signOut() {
      if (!supabase) return;
      const { error } = await supabase.auth.signOut();
      if (error) fail(error.message);
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
