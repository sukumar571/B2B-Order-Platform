import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from '../context/AuthContext.jsx';
import ProductsPage from '../pages/ProductsPage.jsx';
import ProductDetailPage from '../pages/ProductDetailPage.jsx';
import AdminProductsPage from '../pages/AdminProductsPage.jsx';
import InventoryPage from '../pages/InventoryPage.jsx';
import RequireRole from '../components/RequireRole.jsx';

/**
 * Fetch stub keyed by "METHOD /path" (or "/path" for any method). Anything
 * without a stub answers 404, so a test only passes when the component calls
 * the real endpoint with the right query string — i.e. screens render live
 * backend data, never a hardcoded array.
 */
function stubFetch(routes = {}) {
  const fetchMock = vi.fn(async (url, opts = {}) => {
    const path = String(url)
      .split('?')[0]
      .replace(/^https?:\/\/[^/]+/, '');
    const query = String(url).includes('?') ? String(url).split('?')[1] : '';
    const method = (opts.method || 'GET').toUpperCase();
    const hit = routes[`${method} ${path}`] ?? routes[path];
    const resolved = typeof hit === 'function' ? hit({ query, options: opts }) : hit;
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

const PRODUCT_ROW = {
  id: '1',
  sku: 'BACKEND-SKU-99',
  name: 'Fetched Desk Lamp',
  description: 'Real row from the API.',
  unit_price: '41.50',
  tax_rate: '12.00',
  is_active: true,
  physical_quantity: 30,
  reserved_quantity: 4,
  available_stock: 26,
  low_stock_threshold: 20,
};

// meta deliberately matches the documented API contract: page/limit/total only.
const LIST_BODY = {
  data: [PRODUCT_ROW],
  meta: { page: 1, limit: 12, total: 1 },
};

const INVENTORY_BODY = {
  data: [
    {
      product_id: '1',
      sku: 'BACKEND-SKU-99',
      name: 'Fetched Desk Lamp',
      is_active: true,
      physical_quantity: 5,
      reserved_quantity: 1,
      available_quantity: 4,
      low_stock_threshold: 20,
      is_low_stock: true,
    },
  ],
  meta: { page: 1, limit: 20, total: 1 },
};

const USER_BY_ROLE = {
  admin: { id: '9', name: 'Asha Admin', email: 'admin@b2boms.test', role: 'admin' },
  agent: { id: '8', name: 'Ravi Reseller', email: 'agent@b2boms.test', role: 'agent' },
  customer: { id: '3', name: 'Celes Retail', email: 'customer@b2boms.test', role: 'customer' },
};

const loginStub = (role) => ({
  '/api/auth/login': { accessToken: 'jwt.mock', user: USER_BY_ROLE[role] },
});

/** Waits for a session (real /api/auth/login) before mounting protected UI. */
function LoginLoader({ role, children }) {
  const { login, isAuthenticated } = useAuth();
  useEffect(() => {
    if (!isAuthenticated) login(USER_BY_ROLE[role].email, 'Passw0rd!');
  }, [isAuthenticated, login, role]);
  return isAuthenticated ? children : null;
}

function AuthedHarness({ role, route, children }) {
  return (
    <AuthProvider>
      <LoginLoader role={role}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path="/login" element={<p>Login screen</p>} />
            <Route path={route} element={children} />
          </Routes>
        </MemoryRouter>
      </LoginLoader>
    </AuthProvider>
  );
}

function renderAt(route, ui) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </AuthProvider>
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

/** Paths of every call the component made to the API, in order. */
const callsTo = (mock) => mock.mock.calls.map(([u]) => String(u));

describe('ProductsPage — live data, states and pagination', () => {
  it('fetches /api/products with sort/page params and renders the fetched row', async () => {
    const mock = stubFetch({ '/api/products': LIST_BODY });

    renderAt('/products', <ProductsPage />);

    expect(await screen.findByText('Fetched Desk Lamp')).toBeInTheDocument();
    expect(screen.getByText('BACKEND-SKU-99')).toBeInTheDocument();
    expect(screen.getByText('26 in stock')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 1 · 1 product')).toBeInTheDocument();

    // The AuthProvider bootstraps a silent /api/auth/refresh on mount, so match
    // the products call by content rather than by first-call position.
    const calledUrl = callsTo(mock).find((u) => u.includes('/api/products'));
    expect(calledUrl).toContain('/api/products');
    expect(calledUrl).toContain('sort=name');
    expect(calledUrl).toContain('order=asc');
    expect(calledUrl).toContain('page=1');
    expect(calledUrl).toContain('limit=12');
  });

  it('renders the backend-supplied price as data, not a literal', async () => {
    stubFetch({ '/api/products': LIST_BODY });
    renderAt('/products', <ProductsPage />);
    await screen.findByText('Fetched Desk Lamp');
    expect(screen.getByText(/41\.50/)).toBeInTheDocument();
  });

  it('derives the page count from total/limit and pages forward through the API', async () => {
    const rowsFor = (page) => ({
      data: Array.from({ length: 12 }, (_, i) => ({
        ...PRODUCT_ROW,
        id: `${page}-${i}`,
        sku: `PAGE${page}-${i}`,
        name: `Paged Product ${page}-${i}`,
      })),
      meta: { page, limit: 12, total: 55 },
    });
    const mock = stubFetch({ '/api/products': rowsFor(1) });
    mock.mockImplementation(async (url) => {
      const q = String(url).includes('?') ? String(url).split('?')[1] : '';
      const body = q.includes('page=2') ? rowsFor(2) : rowsFor(1);
      return { ok: true, status: 200, json: async () => body };
    });

    renderAt('/products', <ProductsPage />);

    // 55 rows at 12 per page => 5 pages, so Next is enabled on page 1.
    expect(await screen.findByText('Page 1 of 5 · 55 products')).toBeInTheDocument();
    expect(screen.getByText('PAGE1-0')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /next/i }));

    expect(await screen.findByText('Page 2 of 5 · 55 products')).toBeInTheDocument();
    expect(screen.getByText('PAGE2-0')).toBeInTheDocument();
    expect(callsTo(mock).some((u) => u.includes('page=2'))).toBe(true);
  });

  it('sends the search term to the backend (server-side search)', async () => {
    const mock = stubFetch({ '/api/products': LIST_BODY });

    renderAt('/products', <ProductsPage />);
    await screen.findByText('Fetched Desk Lamp');
    mock.mockClear();

    await userEvent.type(screen.getByLabelText(/search products/i), 'lamp');
    await userEvent.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => expect(mock).toHaveBeenCalled());
    expect(String(mock.mock.calls.at(-1)[0])).toContain('search=lamp');
  });

  it('shows the empty state when the backend returns zero rows', async () => {
    stubFetch({
      '/api/products': { data: [], meta: { page: 1, limit: 12, total: 0 } },
    });

    renderAt('/products', <ProductsPage />);

    expect(await screen.findByText('No products match your search')).toBeInTheDocument();
  });

  it('shows the error state and retries through the API on failure', async () => {
    const mock = stubFetch({
      '/api/products': () => fail(503, { error: { message: 'API unavailable' } }),
    });

    renderAt('/products', <ProductsPage />);

    expect(await screen.findByText('Could not load data')).toBeInTheDocument();
    expect(screen.getByText('API unavailable')).toBeInTheDocument();

    mock.mockClear();
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(mock).toHaveBeenCalled();
  });
});

describe('ProductDetailPage', () => {
  const detailRoutes = (
    <Routes>
      <Route path="/products/:id" element={<ProductDetailPage />} />
    </Routes>
  );

  it('fetches GET /api/products/:id and renders the fields', async () => {
    const mock = stubFetch({ '/api/products/1': PRODUCT_ROW });

    renderAt('/products/1', detailRoutes);

    expect(await screen.findByText('Fetched Desk Lamp')).toBeInTheDocument();
    expect(screen.getByText('30 / 4')).toBeInTheDocument();
    // Ignore the mount-time refresh bootstrap call; assert the detail fetch fired.
    expect(callsTo(mock).some((u) => /\/api\/products\/1$/.test(u))).toBe(true);
  });

  it('surfaces the backend 404 for an inactive product viewed by a non-admin', async () => {
    stubFetch({
      '/api/products/9': fail(404, { error: { code: 'NOT_FOUND', message: 'Product not found' } }),
    });

    renderAt('/products/9', detailRoutes);

    expect(await screen.findByText('Product not found')).toBeInTheDocument();
  });
});

describe('Role authorization on the client (backend stays authoritative)', () => {
  it('RequireRole redirects anonymous visitors to /login', async () => {
    stubFetch({});

    renderAt(
      '/inventory',
      <Routes>
        <Route path="/login" element={<p>Sign in first</p>} />
        <Route
          path="/inventory"
          element={
            <RequireRole roles={['admin', 'agent']}>
              <p>Secret inventory table</p>
            </RequireRole>
          }
        />
      </Routes>
    );

    expect(await screen.findByText('Sign in first')).toBeInTheDocument();
    expect(screen.queryByText('Secret inventory table')).not.toBeInTheDocument();
  });

  it('blocks a logged-in CUSTOMER from the admin area', async () => {
    stubFetch(loginStub('customer'));

    render(
      <AuthedHarness role="customer" route="/admin/products">
        <RequireRole roles={['admin']}>
          <AdminProductsPage />
        </RequireRole>
      </AuthedHarness>
    );

    expect(await screen.findByText(/Not authorized/i)).toBeInTheDocument();
    expect(screen.queryByText('Admin · Products')).not.toBeInTheDocument();
  });
});

describe('AdminProductsPage (ADMIN only)', () => {
  it('loads all products incl. inactive and PATCHes deactivation with the bearer token', async () => {
    const mock = stubFetch({
      ...loginStub('admin'),
      '/api/products': LIST_BODY,
      'PATCH /api/products/1': { ...PRODUCT_ROW, is_active: false },
    });

    render(
      <AuthedHarness role="admin" route="/admin/products">
        <AdminProductsPage />
      </AuthedHarness>
    );

    expect(await screen.findByText('Admin · Products')).toBeInTheDocument();
    expect(await screen.findByText('Fetched Desk Lamp')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /deactivate/i }));

    await waitFor(() => {
      const patch = mock.mock.calls.find(
        ([u, o]) => String(u) === '/api/products/1' && (o?.method || 'GET') === 'PATCH'
      );
      expect(patch).toBeDefined();
      expect(patch[1].headers.Authorization).toBe('Bearer jwt.mock');
      expect(JSON.parse(patch[1].body)).toEqual({ is_active: false });
    });
    expect(await screen.findByText(/deactivated/i)).toBeInTheDocument();
  });

  it('surfaces backend validation details from the add-product form', async () => {
    stubFetch({
      ...loginStub('admin'),
      '/api/products': LIST_BODY,
      'POST /api/products': fail(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid input',
          details: { sku: 'Duplicate SKU' },
        },
      }),
    });

    render(
      <AuthedHarness role="admin" route="/admin/products">
        <AdminProductsPage />
      </AuthedHarness>
    );

    await screen.findByText('Fetched Desk Lamp');
    await userEvent.click(screen.getByRole('button', { name: /add product/i }));

    const form = await screen.findByLabelText(/create product form/i);
    await userEvent.type(within(form).getByLabelText('SKU'), 'DUP-1');
    await userEvent.type(within(form).getByLabelText('Name'), 'Dup item');
    await userEvent.type(within(form).getByLabelText('Unit price'), '5');
    await userEvent.click(within(form).getByRole('button', { name: /create product/i }));

    expect(await screen.findByText(/Duplicate SKU/i)).toBeInTheDocument();
  });
});

describe('InventoryPage (ADMIN / ORDER_MANAGER)', () => {
  it('renders the fetched stock row with its low-stock badge; an agent gets no adjust control', async () => {
    const mock = stubFetch({ ...loginStub('agent'), '/api/inventory': INVENTORY_BODY });

    render(
      <AuthedHarness role="agent" route="/inventory">
        <InventoryPage />
      </AuthedHarness>
    );

    expect(await screen.findByText('Fetched Desk Lamp')).toBeInTheDocument();
    expect(screen.getByText('Low stock', { selector: 'span' })).toBeInTheDocument();
    expect(callsTo(mock).some((u) => u.includes('/api/inventory'))).toBe(true);
    // PATCH /api/inventory/:id is ADMIN-only server-side, so no control is offered.
    expect(screen.queryByRole('button', { name: /adjust/i })).not.toBeInTheDocument();
  });

  it('admin adjustment PATCHes /api/inventory/:id and shows the audited result', async () => {
    const mock = stubFetch({
      ...loginStub('admin'),
      '/api/inventory': INVENTORY_BODY,
      'PATCH /api/inventory/1': {
        data: { ...INVENTORY_BODY.data[0], physical_quantity: 25, available_quantity: 24 },
        movement: {
          quantity_delta: 20,
          movement_type: 'stock_receipt',
          available_after: 24,
          reason: 'Delivery',
        },
      },
    });

    render(
      <AuthedHarness role="admin" route="/inventory">
        <InventoryPage />
      </AuthedHarness>
    );

    await screen.findByText('Fetched Desk Lamp');
    await userEvent.click(screen.getByRole('button', { name: /adjust/i }));

    const form = await screen.findByLabelText(/stock adjustment form/i);
    await userEvent.type(within(form).getByLabelText(/quantity change/i), '20');
    await userEvent.type(within(form).getByLabelText(/^reason$/i), 'Delivery');
    await userEvent.click(within(form).getByRole('button', { name: /apply adjustment/i }));

    await waitFor(() => {
      const patch = mock.mock.calls.find(
        ([u, o]) => String(u) === '/api/inventory/1' && (o?.method || 'GET') === 'PATCH'
      );
      expect(patch).toBeDefined();
      expect(patch[1].headers.Authorization).toBe('Bearer jwt.mock');
      expect(JSON.parse(patch[1].body)).toEqual({ delta: 20, reason: 'Delivery' });
    });
    expect(await screen.findByText(/available now 24/i)).toBeInTheDocument();
  });

  it('shows the INSUFFICIENT_STOCK error the backend returns for an over-drawdown', async () => {
    stubFetch({
      ...loginStub('admin'),
      '/api/inventory': INVENTORY_BODY,
      'PATCH /api/inventory/1': fail(409, {
        error: { code: 'INSUFFICIENT_STOCK', message: 'Adjustment would make stock negative' },
      }),
    });

    render(
      <AuthedHarness role="admin" route="/inventory">
        <InventoryPage />
      </AuthedHarness>
    );

    await screen.findByText('Fetched Desk Lamp');
    await userEvent.click(screen.getByRole('button', { name: /adjust/i }));
    const form = await screen.findByLabelText(/stock adjustment form/i);
    await userEvent.type(within(form).getByLabelText(/quantity change/i), '-999');
    await userEvent.type(within(form).getByLabelText(/^reason$/i), 'Shrinkage');
    await userEvent.click(within(form).getByRole('button', { name: /apply adjustment/i }));

    expect(await screen.findByText('Adjustment would make stock negative')).toBeInTheDocument();
  });

  it('low-stock toggle calls GET /api/inventory/low-stock', async () => {
    const mock = stubFetch({
      ...loginStub('admin'),
      '/api/inventory': INVENTORY_BODY,
      '/api/inventory/low-stock': INVENTORY_BODY,
    });

    render(
      <AuthedHarness role="admin" route="/inventory">
        <InventoryPage />
      </AuthedHarness>
    );

    await screen.findByText('Fetched Desk Lamp');
    mock.mockClear();

    await userEvent.click(screen.getByLabelText(/low-stock only/i));

    await waitFor(() => expect(mock).toHaveBeenCalled());
    expect(String(mock.mock.calls.at(-1)[0])).toContain('/api/inventory/low-stock');
  });
});
