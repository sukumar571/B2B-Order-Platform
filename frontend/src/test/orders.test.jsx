import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from '../context/AuthContext.jsx';
import CartPage from '../pages/CartPage.jsx';
import OrderHistoryPage from '../pages/OrderHistoryPage.jsx';
import OrderDetailPage from '../pages/OrderDetailPage.jsx';
import OrderConfirmationPage from '../pages/OrderConfirmationPage.jsx';
import OrderProcessingPage from '../pages/OrderProcessingPage.jsx';
import RequireRole from '../components/RequireRole.jsx';

/**
 * Fetch stub keyed by "METHOD /path" (or bare "/path"). Anything without a stub
 * 404s, so pages only pass when they hit the right order endpoint with the right
 * verb. Bodies + headers are recorded so tests can prove the client never sends
 * prices/customer ids and DOES send an Idempotency-Key on checkout.
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
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (status === 204 ? null : body),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const fail = (status, body) => ({ __status: status, body });

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

/** Full router so in-page <Link>/navigate() resolve to the real order pages. */
function Harness({ role, route, children }) {
  return (
    <AuthProvider>
      <LoginLoader role={role}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path="/login" element={<p>Login screen</p>} />
            <Route path="/cart" element={<CartPage />} />
            <Route path="/orders/manage" element={<OrderProcessingPage />} />
            <Route path="/orders/:id/confirmation" element={<OrderConfirmationPage />} />
            <Route path="/orders/:id" element={<OrderDetailPage />} />
            <Route path="*" element={children} />
          </Routes>
        </MemoryRouter>
      </LoginLoader>
    </AuthProvider>
  );
}

const ITEM = {
  id: '1',
  product_id: '1',
  product_name: 'Widget 100',
  unit_price: '19.99',
  tax_rate: '7.50',
  quantity: 3,
  line_total: '59.97',
  line_tax: '4.50',
};
const ORDER = {
  id: '55',
  customer_id: '3',
  status: 'pending',
  subtotal: '59.97',
  tax_total: '4.50',
  grand_total: '64.47',
  cancellation_reason: null,
  created_at: '2026-01-01T10:00:00.000Z',
  updated_at: '2026-01-01T10:00:00.000Z',
  items: [ITEM],
};
const LIST = { data: [ORDER], meta: { page: 1, limit: 20, total: 1 } };
const CART = {
  id: '17',
  items: [ITEM],
  subtotal: '59.97',
  tax_total: '4.50',
  grand_total: '64.47',
};
const CANCELLED = { ...ORDER, status: 'cancelled', cancellation_reason: 'no longer needed' };

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('OrderHistoryPage', () => {
  it('renders the customer’s own orders with server totals and status', async () => {
    stubFetch({ 'GET /api/orders': LIST, ...loginStub('customer') });
    render(
      <Harness role="customer" route="/orders">
        <OrderHistoryPage />
      </Harness>
    );
    expect(await screen.findByText('#55')).toBeInTheDocument();
    expect(screen.getByText('₹ 64.47')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    // Customers never see the staff-only customer column.
    expect(screen.queryByRole('columnheader', { name: 'Customer' })).not.toBeInTheDocument();
  });

  it('staff listing exposes the customer column', async () => {
    stubFetch({ 'GET /api/orders': LIST, ...loginStub('admin') });
    render(
      <Harness role="admin" route="/orders">
        <OrderHistoryPage />
      </Harness>
    );
    expect(await screen.findByRole('columnheader', { name: 'Customer' })).toBeInTheDocument();
  });
});

describe('OrderDetailPage', () => {
  it('shows the item snapshot, totals and a lifecycle timeline', async () => {
    stubFetch({ 'GET /api/orders/55': ORDER, ...loginStub('customer') });
    render(
      <Harness role="customer" route="/orders/55">
        <OrderDetailPage />
      </Harness>
    );
    expect(await screen.findByText('Widget 100')).toBeInTheDocument();
    expect(screen.getByText('₹ 64.47')).toBeInTheDocument();
    // Snapshot unit price is the historical figure, not a live recompute.
    expect(screen.getByText('₹ 19.99')).toBeInTheDocument();
    expect(screen.getByText('Shipped')).toBeInTheDocument(); // timeline node
  });

  it('cancels with a reason via POST /:id/cancel and re-renders the state', async () => {
    const mock = stubFetch({
      'GET /api/orders/55': ORDER,
      'POST /api/orders/55/cancel': CANCELLED,
      ...loginStub('customer'),
    });
    render(
      <Harness role="customer" route="/orders/55">
        <OrderDetailPage />
      </Harness>
    );
    await screen.findByText('Widget 100');
    await userEvent.click(screen.getByRole('button', { name: /cancel this order/i }));
    const form = await screen.findByRole('form', { name: /cancel order form/i });
    await userEvent.type(
      within(form).getByLabelText(/reason for cancellation/i),
      'no longer needed'
    );
    await userEvent.click(within(form).getByRole('button', { name: /confirm cancellation/i }));

    const post = mock.mock.calls.find(
      ([u, o]) => o?.method === 'POST' && String(u).endsWith('/api/orders/55/cancel')
    );
    expect(JSON.parse(post[1].body)).toEqual({ reason: 'no longer needed' });
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
  });

  it('hides the cancel action once the order is not cancellable', async () => {
    stubFetch({ 'GET /api/orders/55': { ...ORDER, status: 'shipped' }, ...loginStub('customer') });
    render(
      <Harness role="customer" route="/orders/55">
        <OrderDetailPage />
      </Harness>
    );
    await screen.findByText('Widget 100');
    expect(screen.queryByRole('button', { name: /cancel this order/i })).not.toBeInTheDocument();
  });

  it('surfaces a backend 404 for a foreign order (ownership enforced server-side)', async () => {
    stubFetch({
      'GET /api/orders/55': fail(404, {
        error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' },
      }),
      ...loginStub('customer'),
    });
    render(
      <Harness role="customer" route="/orders/55">
        <OrderDetailPage />
      </Harness>
    );
    expect(await screen.findByText(/Could not load data/i)).toBeInTheDocument();
  });
});

describe('OrderConfirmationPage', () => {
  it('confirms the placed order and shows the reserved total', async () => {
    stubFetch({ 'GET /api/orders/55': ORDER, ...loginStub('customer') });
    render(
      <Harness role="customer" route="/orders/55/confirmation">
        <OrderConfirmationPage />
      </Harness>
    );
    expect(await screen.findByText(/your order is placed/i)).toBeInTheDocument();
    expect(screen.getByText('₹ 64.47')).toBeInTheDocument();
    expect(screen.getByText('Widget 100')).toBeInTheDocument();
  });
});

describe('OrderProcessingPage (staff)', () => {
  it('advances an order one legal step via PATCH /:id/status', async () => {
    const confirmed = { ...ORDER, status: 'confirmed' };
    const mock = stubFetch({
      'GET /api/orders': LIST,
      'PATCH /api/orders/55/status': confirmed,
      ...loginStub('agent'),
    });
    render(
      <Harness role="agent" route="/orders/manage">
        <OrderProcessingPage />
      </Harness>
    );
    await screen.findByText('#55');
    await userEvent.click(screen.getByRole('button', { name: /advance → confirmed/i }));
    const patch = mock.mock.calls.find(
      ([u, o]) => o?.method === 'PATCH' && String(u).endsWith('/api/orders/55/status')
    );
    expect(JSON.parse(patch[1].body)).toEqual({ status: 'confirmed' });
    expect(await screen.findByText(/Order #55 → Confirmed/i)).toBeInTheDocument();
  });

  it('shows an inline error when the transition is refused (409)', async () => {
    stubFetch({
      'GET /api/orders': LIST,
      'PATCH /api/orders/55/status': fail(409, {
        error: { code: 'INVALID_STATE_TRANSITION', message: 'Cannot move pending → confirmed' },
      }),
      ...loginStub('admin'),
    });
    render(
      <Harness role="admin" route="/orders/manage">
        <OrderProcessingPage />
      </Harness>
    );
    await screen.findByText('#55');
    await userEvent.click(screen.getByRole('button', { name: /advance → confirmed/i }));
    expect(await screen.findByText(/Cannot move pending → confirmed/i)).toBeInTheDocument();
  });

  it('renders no advance control for a terminal order', async () => {
    stubFetch({
      'GET /api/orders': {
        data: [{ ...ORDER, status: 'delivered' }],
        meta: { page: 1, limit: 20, total: 1 },
      },
      ...loginStub('admin'),
    });
    render(
      <Harness role="admin" route="/orders/manage">
        <OrderProcessingPage />
      </Harness>
    );
    await screen.findByText('#55');
    expect(screen.getByText('No further action')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /advance/i })).not.toBeInTheDocument();
  });
});

describe('Checkout (cart → place order)', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it('posts an empty body with an Idempotency-Key and routes to confirmation', async () => {
    const mock = stubFetch({
      'GET /api/cart': CART,
      'POST /api/orders': ORDER,
      'GET /api/orders/55': ORDER,
      ...loginStub('customer'),
    });
    render(
      <Harness role="customer" route="/cart">
        <CartPage />
      </Harness>
    );
    await screen.findByText('Widget 100');
    await userEvent.click(screen.getByRole('button', { name: /place order/i }));

    const post = mock.mock.calls.find(
      ([u, o]) => o?.method === 'POST' && String(u).endsWith('/api/orders')
    );
    expect(post).toBeTruthy();
    // Body carries no prices and no customer id — the cart is the source.
    expect(JSON.parse(post[1].body)).toEqual({});
    const headers = post[1].headers || {};
    expect(headers['Idempotency-Key']).toMatch(UUID_RE);
    // Navigation to the confirmation view proves the success path.
    expect(await screen.findByText(/your order is placed/i)).toBeInTheDocument();
  });

  it('surfaces an insufficient-stock 409 from the server instead of leaving the cart', async () => {
    stubFetch({
      'GET /api/cart': CART,
      'POST /api/orders': fail(409, {
        error: { code: 'INSUFFICIENT_STOCK', message: 'Insufficient stock for 1 item(s)' },
      }),
      ...loginStub('customer'),
    });
    render(
      <Harness role="customer" route="/cart">
        <CartPage />
      </Harness>
    );
    await screen.findByText('Widget 100');
    await userEvent.click(screen.getByRole('button', { name: /place order/i }));
    expect(await screen.findByText(/Insufficient stock/i)).toBeInTheDocument();
  });
});

describe('Order route guards', () => {
  it('blocks a customer from the staff processing screen', async () => {
    stubFetch(loginStub('customer'));
    render(
      <Harness role="customer" route="/guard-test">
        <RequireRole roles={['admin', 'agent']}>
          <OrderProcessingPage />
        </RequireRole>
      </Harness>
    );
    expect(await screen.findByText(/restricted to/i)).toBeInTheDocument();
  });

  it('blocks an unauthenticated visitor from order history (redirects to login)', async () => {
    stubFetch({});
    render(
      <MemoryRouter initialEntries={['/orders']}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<p>Login screen</p>} />
            <Route
              path="/orders"
              element={
                <RequireRole roles={['customer', 'admin', 'agent']}>
                  <OrderHistoryPage />
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
