import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

const linkClass = ({ isActive }) => (isActive ? 'nav__link nav__link--active' : 'nav__link');

export default function Navbar() {
  const { isAuthenticated, user, logout } = useAuth();
  const navigate = useNavigate();

  async function onLogout() {
    await logout();
    navigate('/');
  }

  return (
    <nav className="nav">
      <Link to="/" className="nav__brand">
        B2B OMS
      </Link>
      <div className="nav__links">
        <NavLink to="/products" className={linkClass}>
          Products
        </NavLink>
        {isAuthenticated && user.role === 'customer' ? (
          <NavLink to="/cart" className={linkClass}>
            Cart
          </NavLink>
        ) : null}
        {isAuthenticated && user.role === 'customer' ? (
          <NavLink to="/orders" className={linkClass}>
            My orders
          </NavLink>
        ) : null}
        {isAuthenticated && (user.role === 'admin' || user.role === 'agent') ? (
          <NavLink to="/orders/manage" className={linkClass}>
            Orders
          </NavLink>
        ) : null}
        {isAuthenticated ? (
          <NavLink to="/invoices" className={linkClass}>
            Invoices
          </NavLink>
        ) : null}
        {isAuthenticated && user.role === 'admin' ? (
          <NavLink to="/admin/products" className={linkClass}>
            Admin · Products
          </NavLink>
        ) : null}
        {isAuthenticated && (user.role === 'admin' || user.role === 'agent') ? (
          <NavLink to="/inventory" className={linkClass}>
            Inventory
          </NavLink>
        ) : null}
        {isAuthenticated && (user.role === 'admin' || user.role === 'agent') ? (
          <NavLink to="/dashboard" className={linkClass}>
            Dashboard
          </NavLink>
        ) : null}
        {isAuthenticated && user.role === 'admin' ? (
          <NavLink to="/audit" className={linkClass}>
            Audit
          </NavLink>
        ) : null}
        {isAuthenticated && user.role === 'admin' ? (
          <NavLink to="/users" className={linkClass}>
            Users
          </NavLink>
        ) : null}
      </div>
      <div className="nav__auth">
        {isAuthenticated ? (
          <>
            <span className="nav__user">
              {user.name} ({user.role})
            </span>
            <button type="button" className="btn btn--secondary" onClick={onLogout}>
              Log out
            </button>
          </>
        ) : (
          <>
            <NavLink to="/login" className={linkClass}>
              Log in
            </NavLink>
            <NavLink to="/register" className={linkClass}>
              Register
            </NavLink>
          </>
        )}
      </div>
    </nav>
  );
}
