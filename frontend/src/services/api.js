// Frontend API client.
// In dev, Vite proxies /api to the backend, so a same-origin relative base
// ('') is the default. Set VITE_API_BASE_URL to point at an absolute origin
// when the SPA and API are served from different hosts.
const BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

// A single refresh hook the AuthContext registers at startup. When any
// authenticated call comes back 401 UNAUTHENTICATED (the access token expired),
// request() calls it ONCE to obtain a fresh access token (from the HttpOnly
// refresh cookie) and transparently replays the original request. Kept here so
// every API function inherits expiry handling without changing call sites.
let refreshHandler = null;
export function setRefreshHandler(fn) {
  refreshHandler = fn;
}

/**
 * Low-level JSON fetch with normalized error handling.
 * Returns parsed JSON on 2xx; throws { code, message, status, details } otherwise.
 * A bearer `token` is attached when provided (protected endpoints). A 401 on a
 * token-bearing call triggers one silent refresh + retry (unless suppressed).
 */
export async function request(path, options = {}) {
  const { token, headers, _skipAuthRefresh, ...rest } = options;
  const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...authHeaders, ...(headers || {}) },
    ...rest,
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const err = new Error(payload?.error?.message || `Request failed (${res.status})`);
    err.code = payload?.error?.code || 'REQUEST_FAILED';
    err.status = res.status;
    err.details = payload?.error?.details;

    // Expired access token: refresh once and replay, so a live session never
    // visibly logs the user out mid-navigation. Login/register carry no bearer
    // token, so their 401s (bad credentials) are never retried here.
    if (
      res.status === 401 &&
      err.code === 'UNAUTHENTICATED' &&
      token &&
      !_skipAuthRefresh &&
      refreshHandler
    ) {
      const fresh = await refreshHandler();
      if (fresh) return request(path, { ...options, token: fresh, _skipAuthRefresh: true });
    }
    throw err;
  }

  return payload;
}

// Health probe used by the landing page.
export function fetchHealth() {
  return request('/api/health');
}

// ── Auth ────────────────────────────────────────────────────────────────────
// The access token is kept in memory only (never localStorage) per the
// security model; the refresh token lives in an HttpOnly cookie the browser
// sends automatically.
export function login(creds) {
  return request('/api/auth/login', { method: 'POST', body: JSON.stringify(creds) });
}
// Public self-service registration. The body is name/email/password ONLY —
// the backend forces the CUSTOMER role (a `role` field is rejected by its
// strict schema), so the client can never mint a privileged account.
export function register(body) {
  return request('/api/auth/register', { method: 'POST', body: JSON.stringify(body) });
}
// Silent re-auth from the HttpOnly refresh cookie → new access token + user.
// _skipAuthRefresh stops the 401 interceptor recursing when the cookie itself
// is expired/reused (that genuinely means "logged out").
export function refresh() {
  return request('/api/auth/refresh', {
    method: 'POST',
    credentials: 'include',
    _skipAuthRefresh: true,
  });
}
export function me(token) {
  return request('/api/auth/me', { token, _skipAuthRefresh: true });
}
export function logout() {
  return request('/api/auth/logout', { method: 'POST', credentials: 'include' });
}

// ── Products ────────────────────────────────────────────────────────────────
function qs(params = {}) {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== ''
  );
  return entries.length ? `?${new URLSearchParams(entries).toString()}` : '';
}

export function fetchProducts(params = {}, token) {
  return request(`/api/products${qs(params)}`, { token });
}
export function fetchProduct(id, token) {
  return request(`/api/products/${encodeURIComponent(id)}`, { token });
}
export function createProduct(body, token) {
  return request('/api/products', { method: 'POST', body: JSON.stringify(body), token });
}
export function updateProduct(id, body, token) {
  return request(`/api/products/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    token,
  });
}

// ── Inventory ───────────────────────────────────────────────────────────────
export function fetchInventory(params = {}, token) {
  return request(`/api/inventory${qs(params)}`, { token });
}
export function fetchLowStock(params = {}, token) {
  return request(`/api/inventory/low-stock${qs(params)}`, { token });
}
export function adjustInventory(productId, body, token) {
  return request(`/api/inventory/${encodeURIComponent(productId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    token,
  });
}

// ── Cart (Phase 6) ─────────────────────────────────────────────────────────
// Self-scoped: there is no cart/customer id in these URLs — the backend
// derives the caller's cart from the bearer token. Prices/totals in every
// response are computed server-side from the live catalog.
export function fetchCart(token) {
  return request('/api/cart', { token });
}
export function addCartItem(body, token) {
  return request('/api/cart/items', { method: 'POST', body: JSON.stringify(body), token });
}
export function updateCartItem(itemId, body, token) {
  return request(`/api/cart/items/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    token,
  });
}
export function removeCartItem(itemId, token) {
  return request(`/api/cart/items/${encodeURIComponent(itemId)}`, { method: 'DELETE', token });
}
export function clearCart(token) {
  return request('/api/cart', { method: 'DELETE', token });
}

// ── Orders (Phase 7) ───────────────────────────────────────────────────────
// Placement is idempotent: `idempotencyKey` becomes the Idempotency-Key header
// the backend claims so a retry replays one order instead of duplicating it.
// The body carries NOTHING but (optionally) explicit items — prices, totals and
// the customer id are all derived server-side. An empty body orders the cart.
export function placeOrder(body, token, idempotencyKey) {
  return request('/api/orders', {
    method: 'POST',
    body: JSON.stringify(body || {}),
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
  });
}
export function fetchOrders(params = {}, token) {
  return request(`/api/orders${qs(params)}`, { token });
}
export function fetchOrder(id, token) {
  return request(`/api/orders/${encodeURIComponent(id)}`, { token });
}
export function fetchOrderItems(id, token) {
  return request(`/api/orders/${encodeURIComponent(id)}/items`, { token });
}
export function updateOrderStatus(id, status, token) {
  return request(`/api/orders/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
    token,
  });
}
export function cancelOrder(id, reason, token) {
  return request(`/api/orders/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
    token,
  });
}

// ── Invoices (Phase 8) ─────────────────────────────────────────────────────
// Read-only for customers: GET /api/invoices and /api/invoices/:id are scoped
// server-side to the caller's own orders (a foreign id 404s), so the client
// never sends or trusts a customer id. Totals come ONLY from the server
// snapshot — there is no client path to alter a financial figure. The single
// write is a staff-only void (POST /:id/void) that flips status and is audited.
export function fetchInvoices(params = {}, token) {
  return request(`/api/invoices${qs(params)}`, { token });
}
export function fetchInvoice(id, token) {
  return request(`/api/invoices/${encodeURIComponent(id)}`, { token });
}
export function fetchOrderInvoice(orderId, token) {
  return request(`/api/orders/${encodeURIComponent(orderId)}/invoice`, { token });
}
export function voidInvoice(id, reason, token) {
  return request(`/api/invoices/${encodeURIComponent(id)}/void`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
    token,
  });
}

// ── Audit trail & dashboards (Phase 9) ─────────────────────────────────────
// All read-only and role-gated SERVER-side. The audit trail is ADMIN-only
// (a non-admin 403s before any handler); the full dashboard is ADMIN-only while
// the order-summary/low-stock reports are the ADMIN + ORDER_MANAGER staff view.
// The client never sends an actor or scope hint — the bearer identity decides all.
export function fetchAuditLogs(params = {}, token) {
  return request(`/api/audit-logs${qs(params)}`, { token });
}
export function fetchDashboard(params = {}, token) {
  return request(`/api/reports/dashboard${qs(params)}`, { token });
}
export function fetchOrderSummary(params = {}, token) {
  return request(`/api/reports/order-summary${qs(params)}`, { token });
}
export function fetchLowStockReport(params = {}, token) {
  return request(`/api/reports/low-stock${qs(params)}`, { token });
}

// ── Administrative user management (Phase 9, ADMIN only) ──────────────────
// The only mutable fields are role and is_active — an audited, self-lockout-
// guarded change. No password/email is ever sent or returned through this path.
export function fetchUsers(params = {}, token) {
  return request(`/api/users${qs(params)}`, { token });
}
export function updateUser(id, body, token) {
  return request(`/api/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    token,
  });
}
