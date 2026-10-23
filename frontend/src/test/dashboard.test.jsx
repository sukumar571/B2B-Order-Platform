import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from '../context/AuthContext.jsx';
import DashboardPage from '../pages/DashboardPage.jsx';
import AuditLogsPage from '../pages/AuditLogsPage.jsx';
import RequireRole from '../components/RequireRole.jsx';

/**
 * Fetch stub keyed by "METHOD /path" (or bare "/path"); anything without a stub
 * 404s, so a page only passes when it hits the RIGHT report/audit endpoint. This
 * is how we prove an order manager calls the staff order-summary and never the
 * admin dashboard (whose audit feed it is not permitted to see).
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

const USER_BY_ROLE = {
  admin: { id: '9', name: 'Asha Admin', email: 'admin@b2boms.test', role: 'admin' },
  agent: { id: '8', name: 'Omar Manager', email: 'agent@b2boms.test', role: 'agent' },
  customer: { id: '3', name: 'Celes Retail', email: 'customer@b2boms.test', role: 'customer' },
};
const loginStub = (role) => ({
  '/api/auth/login': { accessToken: 'jwt.mock', user: USER_BY_ROLE[role] },
});

function LoginLoader({ role, children }) {
  const { login, isAuthenticated } = useAuth();
  useEffect(() => {
    if (!isAuthenticated) login(USER_BY_ROLE[role].email, 'Passw0rd!');
  }, [isAuthenticated, login, role]);
  return isAuthenticated ? children : null;
}

function Harness({ role, route, children }) {
  return (
    <AuthProvider>
      <LoginLoader role={role}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path="/login" element={<p>Login screen</p>} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/audit" element={<AuditLogsPage />} />
            <Route path="/orders/:id" element={<p>Order detail</p>} />
            <Route path="*" element={children} />
          </Routes>
        </MemoryRouter>
      </LoginLoader>
    </AuthProvider>
  );
}

// Logs the given role in, then renders the child behind a RequireRole guard at
// `route`, so a wrong-role visit shows "Not authorized" (not the login redirect).
function GuardedHarness({ role, route, roles, children }) {
  return (
    <AuthProvider>
      <LoginLoader role={role}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path="/login" element={<p>Login screen</p>} />
            <Route path={route} element={<RequireRole roles={roles}>{children}</RequireRole>} />
          </Routes>
        </MemoryRouter>
      </LoginLoader>
    </AuthProvider>
  );
}

// ── Fixtures mirroring the exact backend report/audit shapes ────────────────
const ADMIN_DASHBOARD = {
  data: {
    audience: 'admin',
    generated_at: '2026-10-22T10:00:00.000Z',
    window: { from: '2026-09-22T10:00:00.000Z', to: null, days: 30 },
    totals: {
      total_orders: 12,
      cancelled_orders: 2,
      active_orders: 10,
      booked_order_value: '429.80',
      gross_value_including_cancelled: '500.00',
    },
    orders_by_status: {
      pending: 1,
      confirmed: 2,
      processing: 3,
      shipped: 2,
      delivered: 2,
      cancelled: 2,
    },
    low_stock: { count: 4 },
    recent_orders: [
      {
        id: '55',
        customer_id: '3',
        status: 'shipped',
        subtotal: '39.98',
        tax_total: '3.00',
        grand_total: '42.98',
        created_at: '2026-10-20T09:00:00.000Z',
        updated_at: '2026-10-21T09:00:00.000Z',
      },
    ],
    audit: {
      total_events: 137,
      recent_activity: [
        {
          id: '1',
          actor_id: '9',
          actor_role: 'admin',
          actor_email: 'admin@b2boms.test',
          actor_name: 'Asha Admin',
          action: 'ORDER_CREATED',
          entity_type: 'order',
          entity_id: '55',
          details: {},
          outcome: 'success',
          created_at: '2026-10-20T09:00:00.000Z',
        },
      ],
    },
    metric_definitions: {
      total_orders: 'Count of order rows created in the window.',
      booked_order_value: 'Booked demand, not collected revenue.',
      limitations: 'No payment processing; figures are live snapshots.',
    },
  },
};

// The agent payload is the SAME metrics minus the audit block entirely.
const AGENT_SUMMARY = { data: { ...ADMIN_DASHBOARD.data, audience: 'order_manager' } };
delete AGENT_SUMMARY.data.audit;

const AUDIT_LIST = {
  data: [
    {
      id: '10',
      actor_id: '3',
      actor_role: 'customer',
      actor_email: 'customer@b2boms.test',
      actor_name: 'Celes Retail',
      action: 'LOGIN_FAILED',
      entity_type: 'user',
      entity_id: null,
      details: {},
      outcome: 'failure',
      created_at: '2026-10-21T08:00:00.000Z',
    },
  ],
  meta: { page: 1, limit: 25, total: 1 },
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('DashboardPage — admin view', () => {
  it('renders summary cards, status breakdown and the audit activity feed', async () => {
    stubFetch({ 'GET /api/reports/dashboard': ADMIN_DASHBOARD, ...loginStub('admin') });
    render(
      <Harness role="admin" route="/dashboard">
        <DashboardPage />
      </Harness>
    );
    expect(await screen.findByText('Booked order value')).toBeInTheDocument();
    expect(screen.getByText('₹ 429.80')).toBeInTheDocument();
    expect(screen.getByText('Total orders')).toBeInTheDocument();
    // The admin-only audit feed and its deep link.
    expect(screen.getByText('Recent activity')).toBeInTheDocument();
    expect(screen.getByText('Audit events recorded')).toBeInTheDocument();
    expect(screen.getByText('137')).toBeInTheDocument();
    expect(screen.getByText('Order created', { selector: 'td[title]' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open full audit trail/i })).toBeInTheDocument();
    // Metric honesty disclosure is always rendered.
    expect(screen.getByText(/not collected revenue/i)).toBeInTheDocument();
  });
});

describe('DashboardPage — order-manager view', () => {
  it('shows order metrics but NO audit feed and calls the staff endpoint only', async () => {
    const mock = stubFetch({
      'GET /api/reports/order-summary': AGENT_SUMMARY,
      ...loginStub('agent'),
    });
    render(
      <Harness role="agent" route="/dashboard">
        <DashboardPage />
      </Harness>
    );
    expect(await screen.findByText('Booked order value')).toBeInTheDocument();
    expect(screen.getByText('₹ 429.80')).toBeInTheDocument();
    // No audit-only surfaces for an agent (FR-AUD-03 keeps the trail admin-only).
    expect(screen.queryByText('Recent activity')).not.toBeInTheDocument();
    expect(screen.queryByText('Audit events recorded')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /open full audit trail/i })).not.toBeInTheDocument();
    // And it must have requested the staff summary, never the admin dashboard.
    expect(mock.mock.calls.some(([u]) => String(u).includes('/api/reports/order-summary'))).toBe(
      true
    );
    expect(mock.mock.calls.some(([u]) => String(u).includes('/api/reports/dashboard'))).toBe(false);
  });

  it('surfaces the low-stock warning when products are below threshold', async () => {
    stubFetch({ 'GET /api/reports/order-summary': AGENT_SUMMARY, ...loginStub('agent') });
    render(
      <Harness role="agent" route="/dashboard">
        <DashboardPage />
      </Harness>
    );
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('4')).toBeInTheDocument();
    expect(within(alert).getByRole('link', { name: /review inventory/i })).toBeInTheDocument();
  });
});

describe('AuditLogsPage — admin trail viewer', () => {
  it('renders events with outcome badges and offers NO edit/delete affordance', async () => {
    stubFetch({ 'GET /api/audit-logs': AUDIT_LIST, ...loginStub('admin') });
    render(
      <Harness role="admin" route="/audit">
        <AuditLogsPage />
      </Harness>
    );
    expect(await screen.findByText('Login failed', { selector: 'td[title]' })).toBeInTheDocument();
    expect(screen.getByText('Failure', { selector: 'span' })).toBeInTheDocument();
    // The trail is append-only — nothing here can mutate history.
    expect(screen.queryByRole('button', { name: /delete|edit/i })).not.toBeInTheDocument();
  });

  it('sends the selected filters as query params', async () => {
    const mock = stubFetch({ 'GET /api/audit-logs': AUDIT_LIST, ...loginStub('admin') });
    render(
      <Harness role="admin" route="/audit">
        <AuditLogsPage />
      </Harness>
    );
    await screen.findByText('Login failed', { selector: 'td[title]' });
    await userEvent.selectOptions(screen.getByLabelText('Outcome'), 'failure');
    const hit = mock.mock.calls.find(([u]) => String(u).includes('outcome=failure'));
    expect(hit).toBeTruthy();
  });
});

describe('Role guards', () => {
  it('blocks an authenticated customer from the dashboard', async () => {
    stubFetch({ ...loginStub('customer') });
    render(
      <GuardedHarness role="customer" route="/dashboard" roles={['admin', 'agent']}>
        <DashboardPage />
      </GuardedHarness>
    );
    // Logged in as the wrong role → the guard renders "Not authorized" and the
    // dashboard never loads its metrics.
    expect(await screen.findByText(/not authorized/i)).toBeInTheDocument();
    expect(screen.queryByText('Booked order value')).not.toBeInTheDocument();
  });

  it('redirects an unauthenticated visitor from the audit trail to login', async () => {
    stubFetch({});
    render(
      <MemoryRouter initialEntries={['/audit']}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<p>Login screen</p>} />
            <Route
              path="/audit"
              element={
                <RequireRole roles={['admin']}>
                  <AuditLogsPage />
                </RequireRole>
              }
            />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );
    expect(await screen.findByText(/login screen/i)).toBeInTheDocument();
  });
});
