import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from '../context/AuthContext.jsx';
import InvoiceListPage from '../pages/InvoiceListPage.jsx';
import InvoicePage from '../pages/InvoicePage.jsx';
import RequireRole from '../components/RequireRole.jsx';

/**
 * Fetch stub keyed by "METHOD /path" (or bare "/path"); anything without a stub
 * 404s so pages only pass when they hit the right invoice endpoint. Bodies and
 * headers are recorded so a test can prove the client sends only a void reason
 * and never a total or a customer id (the server owns both).
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

/** Harness wiring the real invoice routes so useParams()/links resolve. */
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
            <Route path="/invoices" element={<InvoiceListPage />} />
            <Route path="/invoices/:id" element={<InvoicePage />} />
            <Route path="/orders/:orderId/invoice" element={<InvoicePage by="order" />} />
            <Route path="/orders/:id" element={<p>Order detail</p>} />
            <Route path="*" element={children} />
          </Routes>
        </MemoryRouter>
      </LoginLoader>
    </AuthProvider>
  );
}

// A list row is the FLAT mapInvoice shape (customer fields inlined).
const ROW = {
  id: '99',
  order_id: '55',
  invoice_number: 'INV-2026-000007',
  issued_by: '9',
  issued_date: '2026-01-05',
  subtotal: '59.97',
  tax_total: '4.50',
  grand_total: '64.47',
  status: 'issued',
  void_reason: null,
  voided_at: null,
  customer_id: '3',
  order_status: 'shipped',
  order_created_at: '2026-01-04T10:00:00.000Z',
  customer_name: 'Celes Retail',
  customer_email: 'customer@b2boms.test',
};
const LIST = { data: [ROW], meta: { page: 1, limit: 20, total: 1 } };

// The detail payload is the NESTED presentInvoice shape.
const DETAIL = {
  id: '99',
  invoice_number: 'INV-2026-000007',
  order_id: '55',
  order_status: 'shipped',
  status: 'issued',
  issued_date: '2026-01-05',
  issued_by: '9',
  void_reason: null,
  voided_at: null,
  subtotal: '59.97',
  tax_total: '4.50',
  grand_total: '64.47',
  customer: { id: '3', name: 'Celes Retail', email: 'customer@b2boms.test' },
  items: [
    { id: '1', product_name: 'Widget 100', quantity: 3, unit_price: '19.99', line_total: '59.97' },
  ],
  distributor: {
    name: 'B2B OMS Demo Distributor',
    tagline: 'Wholesale Distribution — Demonstration Instance',
    address_lines: ['1 Example Way', 'Demo City, DC 00000'],
    contact: 'billing@b2boms.test',
    tax_registration: 'N/A — simulation, no tax registration',
  },
  document_kind: 'invoice',
  demo: true,
  demo_notice:
    'DEMONSTRATION DOCUMENT — this is a simulated business. It is NOT a legal tax invoice and no real tax compliance has been established.',
};
const VOIDED = {
  ...DETAIL,
  status: 'voided',
  void_reason: 'duplicate issue',
  voided_at: '2026-02-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('InvoiceListPage', () => {
  it('shows a customer their own invoice with server totals and no customer column', async () => {
    stubFetch({ 'GET /api/invoices': LIST, ...loginStub('customer') });
    render(
      <Harness role="customer" route="/invoices">
        <InvoiceListPage />
      </Harness>
    );
    expect(await screen.findByText('INV-2026-000007')).toBeInTheDocument();
    expect(screen.getByText('₹ 64.47')).toBeInTheDocument();
    expect(screen.getByText('Issued', { selector: 'span' })).toBeInTheDocument();
    // A customer never gets the Customer column — the backend already scoped them.
    expect(screen.queryByRole('columnheader', { name: 'Customer' })).not.toBeInTheDocument();
  });

  it('shows staff the Customer column and a status filter', async () => {
    stubFetch({ 'GET /api/invoices': LIST, ...loginStub('admin') });
    render(
      <Harness role="admin" route="/invoices">
        <InvoiceListPage />
      </Harness>
    );
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Customer' })).toBeInTheDocument();
    expect(within(table).getByRole('cell', { name: 'Celes Retail' })).toBeInTheDocument();
    expect(screen.getByLabelText('Status')).toBeInTheDocument();
  });

  it('renders an empty state when there are no invoices', async () => {
    stubFetch({
      'GET /api/invoices': { data: [], meta: { page: 1, limit: 20, total: 0 } },
      ...loginStub('customer'),
    });
    render(
      <Harness role="customer" route="/invoices">
        <InvoiceListPage />
      </Harness>
    );
    expect(await screen.findByText('No invoices yet')).toBeInTheDocument();
  });
});

describe('InvoicePage (printable document)', () => {
  it('renders the distributor, bill-to, lines, totals and the demo label', async () => {
    stubFetch({ 'GET /api/invoices/99': DETAIL, ...loginStub('customer') });
    render(
      <Harness role="customer" route="/invoices/99">
        <InvoicePage />
      </Harness>
    );
    expect(await screen.findByText('B2B OMS Demo Distributor')).toBeInTheDocument();
    expect(screen.getByText('INV-2026-000007')).toBeInTheDocument();
    expect(screen.getByText('Celes Retail')).toBeInTheDocument();
    expect(screen.getByText('Widget 100')).toBeInTheDocument();
    expect(screen.getByText('₹ 64.47')).toBeInTheDocument();
    expect(screen.getByText(/DEMONSTRATION DOCUMENT/i)).toBeInTheDocument();
  });

  it('resolves the invoice through the /orders/:orderId/invoice convenience route', async () => {
    const mock = stubFetch({ 'GET /api/orders/55/invoice': DETAIL, ...loginStub('customer') });
    render(
      <Harness role="customer" route="/orders/55/invoice">
        <InvoicePage by="order" />
      </Harness>
    );
    expect(await screen.findByText('INV-2026-000007')).toBeInTheDocument();
    const hit = mock.mock.calls.some(([u]) => String(u).includes('/api/orders/55/invoice'));
    expect(hit).toBe(true);
  });

  it('marks a voided invoice with a VOID stamp and the reason', async () => {
    stubFetch({ 'GET /api/invoices/99': VOIDED, ...loginStub('customer') });
    render(
      <Harness role="customer" route="/invoices/99">
        <InvoicePage />
      </Harness>
    );
    expect(await screen.findByText('VOID')).toBeInTheDocument();
    expect(screen.getByText(/duplicate issue/i)).toBeInTheDocument();
    expect(screen.getByText('Voided')).toBeInTheDocument();
  });

  it('offers staff a void action that posts only a reason and flips status', async () => {
    const mock = stubFetch({
      'GET /api/invoices/99': DETAIL,
      'POST /api/invoices/99/void': VOIDED,
      ...loginStub('admin'),
    });
    render(
      <Harness role="admin" route="/invoices/99">
        <InvoicePage />
      </Harness>
    );
    await screen.findByText('INV-2026-000007');
    await userEvent.click(screen.getByRole('button', { name: /void this invoice/i }));
    await userEvent.type(screen.getByLabelText('Reason for voiding'), 'duplicate issue');
    await userEvent.click(screen.getByRole('button', { name: /confirm void/i }));

    const post = mock.mock.calls.find(
      ([u, o]) => o?.method === 'POST' && String(u).endsWith('/api/invoices/99/void')
    );
    expect(post).toBeTruthy();
    // The only thing the client sends is the reason — never a total or ownership.
    expect(JSON.parse(post[1].body)).toEqual({ reason: 'duplicate issue' });
    expect(await screen.findByText('VOID')).toBeInTheDocument();
  });

  it('does NOT offer a customer any way to alter the invoice', async () => {
    stubFetch({ 'GET /api/invoices/99': DETAIL, ...loginStub('customer') });
    render(
      <Harness role="customer" route="/invoices/99">
        <InvoicePage />
      </Harness>
    );
    await screen.findByText('INV-2026-000007');
    expect(screen.queryByRole('button', { name: /void this invoice/i })).not.toBeInTheDocument();
  });

  it('surfaces an error when the invoice lookup 404s (foreign invoice)', async () => {
    stubFetch({
      'GET /api/invoices/99': fail(404, {
        error: { code: 'INVOICE_NOT_FOUND', message: 'Invoice not found' },
      }),
      ...loginStub('customer'),
    });
    render(
      <Harness role="customer" route="/invoices/99">
        <InvoicePage />
      </Harness>
    );
    expect(await screen.findByText('Could not load data')).toBeInTheDocument();
  });
});

describe('Invoice route guards', () => {
  it('blocks an unauthenticated visitor from invoices (redirects to login)', async () => {
    stubFetch({});
    render(
      <MemoryRouter initialEntries={['/invoices']}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<p>Login screen</p>} />
            <Route
              path="/invoices"
              element={
                <RequireRole roles={['customer', 'admin', 'agent']}>
                  <InvoiceListPage />
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
