import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Optional backend. When VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set,
 * learners can create accounts and their progress is stored in Supabase.
 * Without them the app runs in guest mode with localStorage only.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabase: SupabaseClient | null = url && anonKey ? createClient(url, anonKey) : null;

export const accountsEnabled = supabase !== null;
