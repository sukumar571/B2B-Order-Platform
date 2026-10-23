import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from '../context/AuthContext.jsx';
import RegisterPage from '../pages/RegisterPage.jsx';
import Navbar from '../components/Navbar.jsx';
import * as api from '../services/api.js';

/**
 * Fetch stub keyed by "METHOD /path" (bare "/path" matches any method). Anything
 * unstubbed answers 404 — so the AuthProvider's mount-time refresh bootstrap is
 * a harmless no-op unless a test explicitly stubs it. Bodies/headers are
 * recorded so we can prove the client sends only safe fields and handles expiry.
 */
function stubFetch(routes = {}) {
  const fetchMock = vi.fn(async (url, opts = {}) => {
    const path = String(url)
      .split('?')[0]
      .replace(/^https?:\/\/[^/]+/, '');
    const method = (opts.method || 'GET').toUpperCase();
    const hit = routes[`${method} ${path}`] ?? routes[path];
    const resolved = typeof hit === 'function' ? hit({ options: opts }) : hit;
    if (resolved === undefined) {
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: { code: 'NOT_FOUND', message: `No stub: ${method} ${path}` } }),
      };
    }
    const failed = resolved.__status !== undefined;
    const status = failed ? resolved.__status : 200;
    const body = failed ? resolved.body : resolved;
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const fail = (status, body) => ({ __status: status, body });

const CUSTOMER = { id: '3', name: 'Celes Retail', email: 'customer@b2boms.test', role: 'customer' };
const ADMIN = { id: '9', name: 'Asha Admin', email: 'admin@b2boms.test', role: 'admin' };

const callsFor = (mock, method, path) =>
  mock.mock.calls.filter(([u, o]) => {
    const p = String(u)
      .split('?')[0]
      .replace(/^https?:\/\/[^/]+/, '');
    return (o?.method || 'GET').toUpperCase() === method && p === path;
  });

beforeEach(() => {
  vi.unstubAllGlobals();
  api.setRefreshHandler(null);
});

afterEach(() => {
  api.setRefreshHandler(null);
});

describe('RegisterPage — customer sign-up', () => {
  function renderRegister() {
    return render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/register']}>
          <Routes>
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/products" element={<p>Products home</p>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    );
  }

  async function fillForm(name, email, password) {
    const form = await screen.findByRole('form', { name: /registration form/i });
    await userEvent.type(form.querySelector('[name="name"]'), name);
    await userEvent.type(form.querySelector('[name="email"]'), email);
    await userEvent.type(form.querySelector('[name="password"]'), password);
    await userEvent.type(form.querySelector('[name="confirm"]'), password);
  }

  it('posts only name/email/password (no role) and lands the customer in the app', async () => {
    const mock = stubFetch({
      'POST /api/auth/register': { user: CUSTOMER, accessToken: 'jwt.new' },
    });

    renderRegister();
    await fillForm('Celes Retail', 'customer@b2boms.test', 'Passw0rd123');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    // Navigation + authenticated session prove the success path end to end.
    expect(await screen.findByText('Products home')).toBeInTheDocument();

    const posts = callsFor(mock, 'POST', '/api/auth/register');
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0][1].body);
    expect(body).toEqual({
      name: 'Celes Retail',
      email: 'customer@b2boms.test',
      password: 'Passw0rd123',
    });
    expect(body.role).toBeUndefined(); // the client can never select a role
  });

  it('blocks submission client-side when the password is too weak (no request sent)', async () => {
    const mock = stubFetch({});
    renderRegister();
    await fillForm('Celes', 'customer@b2boms.test', 'short');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/at least 10 characters/i)).toBeInTheDocument();
    expect(callsFor(mock, 'POST', '/api/auth/register')).toHaveLength(0);
  });

  it('surfaces the server rejection and stays on the form', async () => {
    stubFetch({
      'POST /api/auth/register': fail(409, {
        error: { code: 'USER_EXISTS', message: 'An account with that email already exists' },
      }),
    });
    renderRegister();
    // Client-valid but the server refuses it (server is the authority).
    await fillForm('Celes Retail', 'taken@b2boms.test', 'Passw0rd123');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
    expect(screen.getByRole('form', { name: /registration form/i })).toBeInTheDocument();
  });

  it('guards against accidental duplicate submissions', async () => {
    const mock = stubFetch({
      'POST /api/auth/register': { user: CUSTOMER, accessToken: 'jwt.new' },
    });
    renderRegister();
    await fillForm('Celes Retail', 'customer@b2boms.test', 'Passw0rd123');

    const button = screen.getByRole('button', { name: /create account/i });
    await userEvent.click(button);
    await userEvent.click(button); // second click while the first is in flight

    expect(callsFor(mock, 'POST', '/api/auth/register')).toHaveLength(1);
  });
});

describe('AuthContext — silent session rehydration', () => {
  function Probe() {
    const { isAuthenticated, user } = useAuth();
    return isAuthenticated ? <p>Hello {user.name}</p> : <p>anonymous</p>;
  }

  it('restores a session from the refresh cookie on mount (no explicit login)', async () => {
    const mock = stubFetch({
      'POST /api/auth/refresh': { user: ADMIN, accessToken: 'jwt.restored' },
    });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    expect(await screen.findByText('Hello Asha Admin')).toBeInTheDocument();
    expect(callsFor(mock, 'POST', '/api/auth/refresh')).toHaveLength(1);
  });

  it('stays anonymous when the refresh cookie is no longer valid', async () => {
    stubFetch({ 'POST /api/auth/refresh': fail(401, { error: { code: 'TOKEN_REUSED' } }) });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    expect(await screen.findByText('anonymous')).toBeInTheDocument();
  });
});

describe('API client — access-token expiry handling', () => {
  it('refreshes once on a 401 UNAUTHENTICATED and transparently replays the request', async () => {
    // Ordered responses: protected call → 401, refresh → new token, replay → data.
    const responses = [
      {
        ok: false,
        status: 401,
        json: async () => ({
          error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
        }),
      },
      { ok: true, status: 200, json: async () => ({ user: CUSTOMER, accessToken: 'jwt.fresh' }) },
      {
        ok: true,
        status: 200,
        json: async () => ({ data: [], meta: { page: 1, limit: 20, total: 0 } }),
      },
    ];
    const fetchMock = vi.fn(async () => responses.shift());
    vi.stubGlobal('fetch', fetchMock);
    api.setRefreshHandler(async () => {
      const r = await api.refresh();
      return r.accessToken;
    });

    const cart = await api.fetchCart({}, 'jwt.expired');

    expect(cart).toEqual({ data: [], meta: { page: 1, limit: 20, total: 0 } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The replayed request carries the freshly-minted bearer token.
    const replay = fetchMock.mock.calls[2];
    expect(replay[1].headers.Authorization).toBe('Bearer jwt.fresh');
  });

  it('does not retry a 401 from an unauthenticated login (bad credentials surface directly)', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: 'UNAUTHENTICATED', message: 'Invalid credentials' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    api.setRefreshHandler(async () => 'jwt.should.not.be.used');

    await expect(api.login({ email: 'x@y.test', password: 'nope' })).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    });
    // No bearer token was attached, so the interceptor never fires: exactly one call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Navbar — role-aware navigation', () => {
  function LoginLoader({ role, children }) {
    const { login, isAuthenticated } = useAuth();
    useEffect(() => {
      if (!isAuthenticated) login(role === 'admin' ? ADMIN.email : CUSTOMER.email, 'Passw0rd123');
    }, [isAuthenticated, login, role]);
    return isAuthenticated ? children : null;
  }

  function harness(role) {
    return (
      <AuthProvider>
        <MemoryRouter>
          <LoginLoader role={role}>
            <Navbar />
          </LoginLoader>
        </MemoryRouter>
      </AuthProvider>
    );
  }

  it('shows customers the cart/orders links and hides staff areas', async () => {
    stubFetch({ '/api/auth/login': { user: CUSTOMER, accessToken: 'jwt.c' } });
    render(harness('customer'));

    expect(await screen.findByRole('link', { name: /cart/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /my orders/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /users/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /audit/i })).not.toBeInTheDocument();
  });

  it('shows admins the staff workspace links', async () => {
    stubFetch({ '/api/auth/login': { user: ADMIN, accessToken: 'jwt.a' } });
    render(harness('admin'));

    expect(await screen.findByRole('link', { name: /users/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /audit/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /cart/i })).not.toBeInTheDocument();
  });

  it('offers log in / register to anonymous visitors', async () => {
    stubFetch({});
    render(
      <AuthProvider>
        <MemoryRouter>
          <Navbar />
        </MemoryRouter>
      </AuthProvider>
    );
    expect(await screen.findByRole('link', { name: /log in/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /register/i })).toBeInTheDocument();
  });
});
