// Supabase simulado: toda consulta responde vacio (los videos usan datos.js).
const vacio = { data: [], error: null, count: 0 };
const consulta = () => {
  const o = new Proxy({}, { get: (_t, k) => (k === 'then' ? (f) => Promise.resolve(vacio).then(f) : () => o) });
  return o;
};
export const supabase = {
  from: consulta, rpc: () => Promise.resolve({ data: [], error: null }),
  auth: { getUser: async () => ({ data: { user: { email: 'demo@trackflow' } } }), getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signOut: async () => ({}) },
  channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel: () => {},
};
export const isSupabaseActive = () => true;
