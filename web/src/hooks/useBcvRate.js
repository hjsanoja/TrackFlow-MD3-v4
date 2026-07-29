import { useEffect, useState } from 'react';
import { collection, query, orderBy, limit, getDocs, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { supabase, isSupabaseActive } from '../supabase';
import { supabaseInsertSafe } from '../utils/dbClient';

export function useBcvRate() {
  const [rate, setRate] = useState(744.23);
  const [source, setSource] = useState('oficial');
  const [updatedAt, setUpdatedAt] = useState(new Date());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadFromSupabase = async () => {
    try {
      if (!isSupabaseActive()) return null;
      const { data, error } = await supabase
        .from('bcv_rates')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(1);

      if (!error && data && data.length > 0) {
        const val = Number(data[0].value || data[0].valor);
        if (!isNaN(val) && val > 0) {
          setRate(val);
          setSource(data[0].source || 'oficial');
          setUpdatedAt(data[0].updated_at ? new Date(data[0].updated_at) : new Date());
          return data[0];
        }
      }
      return null;
    } catch (err) {
      console.warn('[useBcvRate] aviso leyendo Supabase:', err?.message || String(err));
      return null;
    }
  };

  const loadFromFirestore = async () => {
    try {
      if (!db) return null;
      const q = query(collection(db, 'bcv_rates'), orderBy('updated_at', 'desc'), limit(1));
      const snap = await getDocs(q);
      if (!snap.empty) {
        const data = snap.docs[0].data();
        const val = Number(data.value);
        if (!isNaN(val) && val > 0) {
          setRate(val);
          setSource(data.source || 'oficial');
          setUpdatedAt(data.updated_at?.toDate?.() || new Date());
          return data;
        }
      }
      return null;
    } catch (err) {
      console.warn('[useBcvRate] aviso leyendo Firestore:', err?.message || String(err));
      return null;
    }
  };

  const fetchFromExternalApis = async () => {
    // Intento 1: dolarapi.com
    try {
      const res = await fetch('https://ve.dolarapi.com/v1/dolares/oficial');
      if (res.ok) {
        const json = await res.json();
        const val = Number(json?.promedio || json?.precio);
        if (!isNaN(val) && val > 100) return val;
      }
    } catch (_) {}

    // Intento 2: pydolarve.org
    try {
      const res = await fetch('https://pydolarve.org/api/v1/dollar?page=bcv');
      if (res.ok) {
        const json = await res.json();
        const val = Number(json?.monitors?.usd?.price || json?.price);
        if (!isNaN(val) && val > 100) return val;
      }
    } catch (_) {}

    return null;
  };

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      // 1. Intentar Supabase
      let existing = await loadFromSupabase();
      if (!existing) {
        // 2. Intentar Firestore
        existing = await loadFromFirestore();
      }

      const today = new Date().toDateString();
      const existingDate = existing?.updated_at ? new Date(existing.updated_at).toDateString() : (existing?.updated_at?.toDate?.()?.toDateString?.());
      
      if (existing && existingDate === today) {
        setLoading(false);
        return;
      }

      // 3. Si no hay del día, intentar APIs externas
      const auto = await fetchFromExternalApis();
      if (auto && auto > 100) {
        setRate(auto);
        setSource('auto');
        setUpdatedAt(new Date());

        // Guardar la nueva tasa
        if (isSupabaseActive()) {
          supabaseInsertSafe('bcv_rates', {
            value: auto,
            updated_at: new Date().toISOString()
          }).catch(() => {});
        } else if (db) {
          addDoc(collection(db, 'bcv_rates'), {
            value: auto,
            source: 'auto',
            updated_at: serverTimestamp(),
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.warn('[useBcvRate] aviso en refresh:', err?.message || String(err));
    }
    setLoading(false);
  };

  const setManual = async (value) => {
    setError(null);
    const num = parseFloat(String(value).replace(',', '.'));
    if (!num || isNaN(num) || num <= 0) {
      setError('La tasa debe ser un número positivo (usa punto, no coma)');
      return false;
    }
    setRate(num);
    setSource('manual');
    setUpdatedAt(new Date());

    try {
      if (isSupabaseActive()) {
        await supabaseInsertSafe('bcv_rates', {
          value: num,
          updated_at: new Date().toISOString()
        });
      } else if (db) {
        await addDoc(collection(db, 'bcv_rates'), {
          value: num,
          source: 'manual',
          updated_at: serverTimestamp(),
        });
      }
      return true;
    } catch (err) {
      console.warn('[useBcvRate] guardado local tras aviso:', err?.message || String(err));
      return true;
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  return { rate, source, updatedAt, loading, error, refresh, setManual };
}


