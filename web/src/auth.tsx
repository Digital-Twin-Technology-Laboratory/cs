import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import type { CheckQuota, SiteInfo, User } from './types';

interface AuthCtx {
  user: User | null;
  site: SiteInfo | null;
  checkQuota: CheckQuota | null;
  loading: boolean;
  refresh: () => Promise<void>;
  setUser: (u: User | null) => void;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [site, setSite] = useState<SiteInfo | null>(null);
  const [checkQuota, setCheckQuota] = useState<CheckQuota | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ user: User | null; site: SiteInfo; checkQuota: CheckQuota | null }>('/api/auth/me');
      setUser(r.user);
      setSite(r.site);
      setCheckQuota(r.checkQuota);
      document.title = r.site.siteName;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const onExpired = () => setUser(null);
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, [refresh]);

  const logout = async () => {
    await api.post('/api/auth/logout');
    setUser(null);
    await refresh();
  };

  return <Ctx.Provider value={{ user, site, checkQuota, loading, refresh, setUser, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
