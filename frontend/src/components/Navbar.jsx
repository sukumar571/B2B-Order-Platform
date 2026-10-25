import { Children, useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

const linkClass = ({ isActive }) => (isActive ? 'nav__link nav__link--active' : 'nav__link');

/** One sidebar navigation row: an icon (decorative) plus the link's text label. */
function SideLink({ to, icon, children, onNavigate }) {
  return (
    <NavLink to={to} className={linkClass} onClick={onNavigate}>
      <span className="nav__link__icon" aria-hidden="true">
        {icon}
      </span>
      <span>{children}</span>
    </NavLink>
  );
}

function NavGroup({ label, children }) {
  const items = Children.toArray(children).filter(Boolean);
  if (items.length === 0) return null;
  return (
    <div className="nav-group">
      <p className="nav-group__label">{label}</p>
      <div className="nav-group__list">{items}</div>
    </div>
  );
}

/**
 * Responsive primary navigation. Desktop renders a persistent left sidebar;
 * below the breakpoint it collapses to an off-canvas drawer opened from a
 * sticky app bar. Link targets and role-based visibility are unchanged, so
 * the auth surface and behaviour are identical to the previous top navbar.
 */
export default function Navbar() {
  const { isAuthenticated, user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);

  // Close the drawer whenever the route changes (e.g. after clicking a link).
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  // Escape closes the drawer.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  async function onLogout() {
    await logout();
    navigate('/');
  }

  const isCustomer = isAuthenticated && user.role === 'customer';
  const isStaff = isAuthenticated && (user.role === 'admin' || user.role === 'agent');
  const isAdmin = isAuthenticated && user.role === 'admin';

  const closeDrawer = () => setOpen(false);

  return (
    <>
      {/* Mobile / tablet app bar */}
      <header className="appbar">
        <button
          type="button"
          className="appbar__menu"
          aria-label={open ? 'Close navigation' : 'Open navigation'}
          aria-controls="primary-navigation"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          ☰
        </button>
        <Link to="/" className="appbar__brand">
          B2B OMS
        </Link>
        <span className="appbar__spacer" />
      </header>

      {open ? <div className="scrim" aria-hidden="true" onClick={closeDrawer} /> : null}

      {/* Sidebar / drawer */}
      <nav
        id="primary-navigation"
        className="sidebar"
        aria-label="Primary"
        data-open={open ? 'true' : 'false'}
      >
        <div className="sidebar__head">
          <Link to="/" className="sidebar__brand" onClick={closeDrawer}>
            <span className="sidebar__logo" aria-hidden="true">
              B2
            </span>
            <span className="sidebar__brand-text">
              <span className="sidebar__brand-title">B2B OMS</span>
              <span className="sidebar__brand-sub">Order Platform</span>
            </span>
          </Link>
          <button
            type="button"
            className="sidebar__close"
            aria-label="Close navigation"
            onClick={closeDrawer}
          >
            ×
          </button>
        </div>

        <div className="sidebar__nav">
          <NavGroup label="Browse">
            <SideLink to="/products" icon="🛍️" onNavigate={closeDrawer}>
              Products
            </SideLink>
          </NavGroup>

          {isCustomer ? (
            <NavGroup label="Shopping">
              <SideLink to="/cart" icon="🧺" onNavigate={closeDrawer}>
                Cart
              </SideLink>
              <SideLink to="/orders" icon="📦" onNavigate={closeDrawer}>
                My orders
              </SideLink>
              <SideLink to="/invoices" icon="🧾" onNavigate={closeDrawer}>
                Invoices
              </SideLink>
            </NavGroup>
          ) : null}

          {isStaff ? (
            <NavGroup label="Operations">
              <SideLink to="/orders/manage" icon="🗂️" onNavigate={closeDrawer}>
                Orders
              </SideLink>
              <SideLink to="/invoices" icon="🧾" onNavigate={closeDrawer}>
                Invoices
              </SideLink>
              <SideLink to="/inventory" icon="📊" onNavigate={closeDrawer}>
                Inventory
              </SideLink>
              <SideLink to="/dashboard" icon="📈" onNavigate={closeDrawer}>
                Dashboard
              </SideLink>
            </NavGroup>
          ) : null}

          {isAdmin ? (
            <NavGroup label="Administration">
              <SideLink to="/admin/products" icon="🏷️" onNavigate={closeDrawer}>
                Admin · Products
              </SideLink>
              <SideLink to="/users" icon="👥" onNavigate={closeDrawer}>
                Users
              </SideLink>
              <SideLink to="/audit" icon="🔍" onNavigate={closeDrawer}>
                Audit
              </SideLink>
            </NavGroup>
          ) : null}
        </div>

        <div className="sidebar__footer">
          {isAuthenticated ? (
            <>
              <div className="user-chip">
                <span className="user-chip__avatar" aria-hidden="true">
                  {(user.name || '?').charAt(0).toUpperCase()}
                </span>
                <span className="user-chip__meta">
                  <span className="user-chip__name">{user.name}</span>
                  <span className="user-chip__role">{user.role}</span>
                </span>
              </div>
              <button type="button" className="btn btn--secondary" onClick={onLogout}>
                Log out
              </button>
            </>
          ) : (
            <div className="nav-group__list">
              <SideLink to="/login" icon="🔑" onNavigate={closeDrawer}>
                Log in
              </SideLink>
              <SideLink to="/register" icon="✨" onNavigate={closeDrawer}>
                Register
              </SideLink>
            </div>
          )}
        </div>
      </nav>
    </>
  );
}
