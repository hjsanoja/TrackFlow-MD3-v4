import { createClient } from '@supabase/supabase-js';

let rawUrl = (import.meta.env.VITE_SUPABASE_URL || '').trim().replace(/\/+$/, '');
if (rawUrl.endsWith('/rest/v1')) {
  rawUrl = rawUrl.slice(0, -8).replace(/\/+$/, '');
}

const supabaseUrl = rawUrl;
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();

export const supabase = createClient(
  supabaseUrl || 'https://mock.supabase.co',
  supabaseAnonKey || 'mock-anon-key'
);

export const isSupabaseActive = () => {
  return Boolean(supabaseUrl && supabaseUrl.startsWith('http') && !supabaseUrl.includes('mock.supabase.co'));
};


