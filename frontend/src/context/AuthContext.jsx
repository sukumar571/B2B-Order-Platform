import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as api from '../services/api.js';

/**
 * Auth context. Per the security model (README / D-19) the access token is held
 * IN MEMORY ONLY — never localStorage/sessionStorage — so an XSS payload cannot
 * trivially exfiltrate it. The refresh token stays in an HttpOnly cookie that
 * the browser attaches automatically to /api/auth/* calls.
 */
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  // session = { token, user } or null.
  const [session, setSession] = useState(null);
  // Concurrency guard: overlapping 401s must share ONE refresh, otherwise a
  // second call would replay an already-rotated refresh token and trip the
  // backend's family-revocation (theft) defence.
  const inflightRefresh = useRef(null);

  const login = useCallback(async (email, password) => {
    const res = await api.login({ email, password });
    setSession({ token: res.accessToken, user: res.user });
    return res.user;
  }, []);

  // Public customer sign-up. Same in-memory token handling as login; the
  // backend fixes the role to CUSTOMER regardless of the payload.
  const register = useCallback(async ({ name, email, password }) => {
    const res = await api.register({ name, email, password });
    setSession({ token: res.accessToken, user: res.user });
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // Best-effort: clear local state even if the server call fails.
    }
    setSession(null);
  }, []);

  // One refresh, de-duplicated across concurrent callers. Returns the fresh
  // access token (consumed by the API 401 interceptor) or null when the session
  // is genuinely gone. `clearOnFail` distinguishes the two triggers:
  //   • interceptor (true)  — a live session's token expired and the cookie no
  //     longer refreshes it, so we must log out and let guards redirect.
  //   • bootstrap  (false) — a best-effort restore on a cold start; a failure
  //     simply means "not logged in yet" and must NOT clobber a session another
  //     path (e.g. an in-flight login) has just established.
  const performRefresh = useCallback((clearOnFail) => {
    if (!inflightRefresh.current) {
      inflightRefresh.current = api
        .refresh()
        .then((res) => {
          if (res && res.accessToken && res.user) {
            setSession({ token: res.accessToken, user: res.user });
            return res.accessToken;
          }
          if (clearOnFail) setSession(null);
          return null;
        })
        .catch(() => {
          if (clearOnFail) setSession(null);
          return null;
        })
        .finally(() => {
          inflightRefresh.current = null;
        });
    }
    return inflightRefresh.current;
  }, []);

  // Publish the refresh hook to the API client so every authenticated request
  // transparently recovers from an expired access token.
  useEffect(() => {
    const handler = () => performRefresh(true);
    api.setRefreshHandler(handler);
    return () => api.setRefreshHandler(null);
  }, [performRefresh]);

  // Silent rehydration: on first mount, try to restore a session from the
  // HttpOnly refresh cookie (the in-memory token is lost on a page reload).
  // A ref guard keeps this to once per provider instance so React StrictMode's
  // double-invoke cannot rotate/revoke the refresh token.
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    performRefresh(false);
  }, [performRefresh]);

  const value = useMemo(
    () => ({
      session,
      token: session?.token,
      user: session?.user,
      role: session?.user?.role,
      isAuthenticated: Boolean(session),
      login,
      register,
      logout,
    }),
    [session, login, register, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
