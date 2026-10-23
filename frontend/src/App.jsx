import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import HealthStatus from './components/HealthStatus.jsx';
import { useHealth } from './hooks/useHealth.js';
import { AuthProvider } from './context/AuthContext.jsx';
import RequireRole from './components/RequireRole.jsx';
import Navbar from './components/Navbar.jsx';
import ProductsPage from './pages/ProductsPage.jsx';
import ProductDetailPage from './pages/ProductDetailPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import RegisterPage from './pages/RegisterPage.jsx';
import AdminProductsPage from './pages/AdminProductsPage.jsx';
import InventoryPage from './pages/InventoryPage.jsx';
import CartPage from './pages/CartPage.jsx';
import OrderHistoryPage from './pages/OrderHistoryPage.jsx';
import OrderDetailPage from './pages/OrderDetailPage.jsx';
import OrderConfirmationPage from './pages/OrderConfirmationPage.jsx';
import OrderProcessingPage from './pages/OrderProcessingPage.jsx';
import InvoiceListPage from './pages/InvoiceListPage.jsx';
import InvoicePage from './pages/InvoicePage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import AuditLogsPage from './pages/AuditLogsPage.jsx';
import UsersPage from './pages/UsersPage.jsx';

/** Landing page — hero + the Phase 2 health probe that proves the stack is wired. */
function HomePage() {
  const { status, data, error, retry } = useHealth();

  return (
    <main className="page">
      <section className="hero">
        <p className="hero__eyebrow">B2B Order Management Platform</p>
        <h1 className="hero__title">Order management, without the spreadsheets.</h1>
        <p className="hero__subtitle">
          Distributors and customers place validated orders against real-time stock, with every
          change audited and invoiced automatically.
        </p>
        <p className="hero__cta">
          <Link to="/products" className="btn">
            Browse products
          </Link>{' '}
          <Link to="/register" className="btn btn--secondary">
            Create account
          </Link>
        </p>
      </section>

      <section className="card" aria-labelledby="health-heading">
        <h2 id="health-heading" className="card__title">
          System status
        </h2>
        <HealthStatus status={status} data={data} error={error} onRetry={retry} />
      </section>

      <footer className="footer">
        <small>
          B2B Order Management Platform — catalog, cart, orders, invoices, dashboards and audit
          trail, all served live from the API.
        </small>
      </footer>
    </main>
  );
}

/**
 * App shell: in-memory auth context + client-side routing. Route guards are
 * UX only — every protected endpoint re-checks roles server-side.
 */
export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Navbar />
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/products" element={<ProductsPage />} />
          <Route path="/products/:id" element={<ProductDetailPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route
            path="/cart"
            element={
              <RequireRole roles={['customer']}>
                <CartPage />
              </RequireRole>
            }
          />
          <Route
            path="/orders"
            element={
              <RequireRole roles={['customer', 'admin', 'agent']}>
                <OrderHistoryPage />
              </RequireRole>
            }
          />
          <Route
            path="/orders/manage"
            element={
              <RequireRole roles={['admin', 'agent']}>
                <OrderProcessingPage />
              </RequireRole>
            }
          />
          <Route
            path="/orders/:orderId/invoice"
            element={
              <RequireRole roles={['customer', 'admin', 'agent']}>
                <InvoicePage by="order" />
              </RequireRole>
            }
          />
          <Route
            path="/invoices"
            element={
              <RequireRole roles={['customer', 'admin', 'agent']}>
                <InvoiceListPage />
              </RequireRole>
            }
          />
          <Route
            path="/invoices/:id"
            element={
              <RequireRole roles={['customer', 'admin', 'agent']}>
                <InvoicePage />
              </RequireRole>
            }
          />
          <Route
            path="/orders/:id/confirmation"
            element={
              <RequireRole roles={['customer']}>
                <OrderConfirmationPage />
              </RequireRole>
            }
          />
          <Route
            path="/orders/:id"
            element={
              <RequireRole roles={['customer', 'admin', 'agent']}>
                <OrderDetailPage />
              </RequireRole>
            }
          />
          <Route
            path="/admin/products"
            element={
              <RequireRole roles={['admin']}>
                <AdminProductsPage />
              </RequireRole>
            }
          />
          <Route
            path="/inventory"
            element={
              <RequireRole roles={['admin', 'agent']}>
                <InventoryPage />
              </RequireRole>
            }
          />
          <Route
            path="/dashboard"
            element={
              <RequireRole roles={['admin', 'agent']}>
                <DashboardPage />
              </RequireRole>
            }
          />
          <Route
            path="/audit"
            element={
              <RequireRole roles={['admin']}>
                <AuditLogsPage />
              </RequireRole>
            }
          />
          <Route
            path="/users"
            element={
              <RequireRole roles={['admin']}>
                <UsersPage />
              </RequireRole>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
