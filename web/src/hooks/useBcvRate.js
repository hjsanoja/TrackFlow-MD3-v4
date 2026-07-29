import { useEffect, useState } from 'react';
import { collection, query, orderBy, limit, getDocs, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';

export function useBcvRate() {
  const [rate, setRate] = useState(45.00);
  const [source, setSource] = useState('oficial');
  const [updatedAt, setUpdatedAt] = useState(new Date());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadFromFirestore = async () => {
    try {
      if (!db) return null;
      const q = query(collection(db, 'bcv_rates'), orderBy('updated_at', 'desc'), limit(1));
      const snap = await getDocs(q);
      if (!snap.empty) {
        const data = snap.docs[0].data();
        setRate(data.value);
        setSource(data.source || 'oficial');
        setUpdatedAt(data.updated_at?.toDate?.() || new Date());
        return data;
      }
      return null;
    } catch (err) {
      console.warn('[useBcvRate] aviso leyendo Firestore:', err?.message || String(err));
      return null;
    }
  };

  const fetchFromPyDolar = async () => {
    try {
      const res = await fetch('https://pydolarve.org/api/v2/dollar?page=bcv');
      if (!res.ok) return null;
      const json = await res.json();
      const value = json?.monitors?.usd?.price || json?.price;
      if (typeof value === 'number' && value > 0) return value;
      return null;
    } catch {
      return null;
    }
  };

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const existing = await loadFromFirestore();
      const today = new Date().toDateString();
      const existingDate = existing?.updated_at?.toDate?.()?.toDateString?.();
      if (existing && existingDate === today) {
        setLoading(false);
        return;
      }

      const auto = await fetchFromPyDolar();
      if (auto) {
        setRate(auto);
        setSource('auto');
        setUpdatedAt(new Date());
        try {
          if (db) {
            await addDoc(collection(db, 'bcv_rates'), {
              value: auto,
              source: 'auto',
              updated_at: serverTimestamp(),
            });
          }
        } catch (err) {
          console.warn('[useBcvRate] no pude guardar tasa auto:', err?.message || String(err));
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
      if (db) {
        await addDoc(collection(db, 'bcv_rates'), {
          value: num,
          source: 'manual',
          updated_at: serverTimestamp(),
        });
      }
      return true;
    } catch (err) {
      console.warn('[useBcvRate] guardado en memoria local tras aviso de Firestore:', err?.message || String(err));
      return true;
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  return { rate, source, updatedAt, loading, error, refresh, setManual };
}

