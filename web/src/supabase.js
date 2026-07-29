import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const supabase = createClient(
  supabaseUrl || 'https://mock.supabase.co',
  supabaseAnonKey || 'mock-anon-key'
);

export const isSupabaseActive = () => {
  return Boolean(supabaseUrl && supabaseUrl.startsWith('http') && !supabaseUrl.includes('mock.supabase.co'));
};

