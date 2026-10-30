import { TASA } from './datos';
export const useBcvRate = () => ({ rate: TASA, loading: false, error: null, refresh: () => {} });
