import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from '../context/AuthContext.jsx';
import CartPage from '../pages/CartPage.jsx';
import ProductDetailPage from '../pages/ProductDetailPage.jsx';
import RequireRole from '../components/RequireRole.jsx';

/**
 * Fetch stub keyed by "METHOD /path" (or "/path" for any method). Anything
 * without a stub answers 404, so a component only passes when it calls the
 * real cart endpoint with the right verb. Bodies are recorded so tests can
 * prove the client never sends prices/totals or an owner id.
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
      // 204 → empty body, mirroring DELETE /api/cart.
      json: async () => (status === 204 ? null : body),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const fail = (status, body) => ({ __status: status, body });

const USER_BY_ROLE = {
  admin: { id: '9', name: 'Asha Admin', email: 'admin@b2boms.test', role: 'admin' },
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
            <Route path="/products/:id" element={<ProductDetailPage />} />
            <Route path="*" element={children} />
          </Routes>
        </MemoryRouter>
      </LoginLoader>
    </AuthProvider>
  );
}

const ITEM = {
  id: '7',
  product_id: '1',
  product_name: 'Widget 100',
  sku: 'WG-100',
  unit_price: '19.99',
  tax_rate: '7.50',
  quantity: 3,
  line_total: '59.97',
  line_tax: '4.50',
  available_now: 100,
  is_active: true,
  unavailable: false,
  stock_warning: false,
};
const CART = {
  id: '17',
  items: [ITEM],
  subtotal: '59.97',
  tax_total: '4.50',
  grand_total: '64.47',
};
const EMPTY = { id: '17', items: [], subtotal: '0.00', tax_total: '0.00', grand_total: '0.00' };

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('CartPage', () => {
  it('renders live cart lines and server-derived totals', async () => {
    stubFetch({ 'GET /api/cart': CART, ...loginStub('customer') });
    render(
      <Harness role="customer" route="/cart">
        <CartPage />
      </Harness>
    );

    expect(await screen.findByText('Widget 100')).toBeInTheDocument();
    expect(screen.getByText('₹ 64.47')).toBeInTheDocument(); // grand total, from the API
    // The line total rendered on the item is the server figure, not a client
    // recomputation — assert it inside the line, and the summary separately.
    expect(
      screen.getByText('₹ 59.97', { selector: '.cart-item__total strong' })
    ).toBeInTheDocument();
    const summary = document.querySelector('.cart__summary');
    expect(within(summary).getByText('Subtotal').parentElement).toHaveTextContent('₹ 59.97');
    expect(within(summary).getByText('Tax').parentElement).toHaveTextContent('₹ 4.50');
  });

  it('shows the empty-cart state when there are no lines', async () => {
    stubFetch({ 'GET /api/cart': EMPTY, ...loginStub('customer') });
    render(
      <Harness role="customer" route="/cart">
        <CartPage />
      </Harness>
    );
    expect(await screen.findByText('Your cart is empty')).toBeInTheDocument();
  });

  it('shows a stock warning when the stored quantity exceeds on-hand', async () => {
    const warned = {
      ...CART,
      items: [{ ...ITEM, available_now: 5, quantity: 15, stock_warning: true }],
    };
    stubFetch({ 'GET /api/cart': warned, ...loginStub('customer') });
    render(
      <Harness role="customer" route="/cart">
        <CartPage />
      </Harness>
    );
    expect(await screen.findByText(/Only 5 in stock/i)).toBeInTheDocument();
  });

  it('increments quantity via PATCH with an absolute value and re-renders', async () => {
    const updated = {
      ...CART,
      items: [{ ...ITEM, quantity: 4, line_total: '79.96' }],
      subtotal: '79.96',
    };
    const mock = stubFetch({
      'GET /api/cart': CART,
      'PATCH /api/cart/items/7': updated,
      ...loginStub('customer'),
    });
    render(
      <Harness role="customer" route="/cart">
        <CartPage />
      </Harness>
    );
    await screen.findByText('Widget 100');

    await userEvent.click(screen.getByLabelText('increase quantity'));

    const patch = mock.mock.calls.find(
      ([u, o]) => o?.method === 'PATCH' && String(u).includes('/api/cart/items/7')
    );
    expect(patch).toBeTruthy();
    expect(JSON.parse(patch[1].body)).toEqual({ quantity: 4 });
    expect(
      await screen.findByText('₹ 79.96', { selector: '.cart-item__total strong' })
    ).toBeInTheDocument();
  });

  it('removes a line via DELETE and re-renders the returned cart', async () => {
    const mock = stubFetch({
      'GET /api/cart': CART,
      'DELETE /api/cart/items/7': EMPTY,
      ...loginStub('customer'),
    });
    render(
      <Harness role="customer" route="/cart">
        <CartPage />
      </Harness>
    );
    await screen.findByText('Widget 100');
    await userEvent.click(screen.getByLabelText(/remove Widget 100/i));
    expect(
      mock.mock.calls.some(
        ([u, o]) => o?.method === 'DELETE' && String(u).endsWith('/api/cart/items/7')
      )
    ).toBe(true);
    expect(await screen.findByText('Your cart is empty')).toBeInTheDocument();
  });

  it('empties the whole cart via DELETE /api/cart', async () => {
    const mock = stubFetch({
      'GET /api/cart': CART,
      'DELETE /api/cart': { __status: 204, body: null },
      ...loginStub('customer'),
    });
    render(
      <Harness role="customer" route="/cart">
        <CartPage />
      </Harness>
    );
    await screen.findByText('Widget 100');
    await userEvent.click(screen.getByRole('button', { name: 'Empty cart' }));
    expect(
      mock.mock.calls.some(([u, o]) => o?.method === 'DELETE' && String(u).endsWith('/api/cart'))
    ).toBe(true);
    expect(await screen.findByText('Your cart is empty')).toBeInTheDocument();
  });

  it('surfaces a backend 409 when a quantity increase exceeds stock', async () => {
    stubFetch({
      'GET /api/cart': CART,
      'PATCH /api/cart/items/7': fail(409, {
        error: {
          code: 'INSUFFICIENT_STOCK',
          message: 'Requested quantity exceeds available stock',
        },
      }),
      ...loginStub('customer'),
    });
    render(
      <Harness role="customer" route="/cart">
        <CartPage />
      </Harness>
    );
    await screen.findByText('Widget 100');
    await userEvent.click(screen.getByLabelText('increase quantity'));
    expect(
      await screen.findByText(/Requested quantity exceeds available stock/i)
    ).toBeInTheDocument();
  });

  it('shows an API error state when the cart cannot be loaded', async () => {
    stubFetch({
      'GET /api/cart': fail(500, { error: { code: 'INTERNAL_ERROR', message: 'boom' } }),
      ...loginStub('customer'),
    });
    render(
      <Harness role="customer" route="/cart">
        <CartPage />
      </Harness>
    );
    expect(await screen.findByText(/Could not load data/i)).toBeInTheDocument();
  });
});

describe('AddToCart (on the product detail page)', () => {
  const PRODUCT = {
    id: '1',
    sku: 'WG-100',
    name: 'Widget 100',
    description: 'Industrial widget',
    unit_price: '19.99',
    tax_rate: '7.50',
    is_active: true,
    physical_quantity: 100,
    reserved_quantity: 0,
    available_stock: 100,
    low_stock_threshold: 20,
  };

  it('posts only product_id + quantity (never a price) and confirms', async () => {
    const mock = stubFetch({
      '/api/products/1': PRODUCT,
      'POST /api/cart/items': CART,
      ...loginStub('customer'),
    });
    render(
      <Harness role="customer" route="/products/1">
        <CartPage />
      </Harness>
    );
    const form = await screen.findByRole('form', { name: /add to cart/i });
    await userEvent.clear(within(form).getByLabelText('Qty'));
    await userEvent.type(within(form).getByLabelText('Qty'), '3');
    await userEvent.click(within(form).getByRole('button', { name: /add to cart/i }));

    const post = mock.mock.calls.find(
      ([u, o]) => o?.method === 'POST' && String(u).endsWith('/api/cart/items')
    );
    expect(post).toBeTruthy();
    const body = JSON.parse(post[1].body);
    expect(body).toEqual({ product_id: '1', quantity: 3 });
    expect('unit_price' in body).toBe(false);
    expect('customer_id' in body).toBe(false);
    expect(await screen.findByText(/Added/i)).toBeInTheDocument();
  });

  it('shows the insufficient-stock error from the backend', async () => {
    stubFetch({
      '/api/products/1': PRODUCT,
      'POST /api/cart/items': fail(409, {
        error: {
          code: 'INSUFFICIENT_STOCK',
          message: 'Requested quantity exceeds available stock',
        },
      }),
      ...loginStub('customer'),
    });
    render(
      <Harness role="customer" route="/products/1">
        <CartPage />
      </Harness>
    );
    const form = await screen.findByRole('form', { name: /add to cart/i });
    await userEvent.click(within(form).getByRole('button', { name: /add to cart/i }));
    expect(
      await screen.findByText(/Requested quantity exceeds available stock/i)
    ).toBeInTheDocument();
  });
});

describe('Cart route guard', () => {
  it('blocks a non-customer (admin) from the cart screen', async () => {
    stubFetch(loginStub('admin'));
    render(
      <Harness role="admin" route="/cart">
        <RequireRole roles={['customer']}>
          <CartPage />
        </RequireRole>
      </Harness>
    );
    expect(await screen.findByText(/restricted to/i)).toBeInTheDocument();
  });
});
