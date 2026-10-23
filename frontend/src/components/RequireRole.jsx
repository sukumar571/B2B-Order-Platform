import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

/**
 * Client-side navigation guard. NOTE: this is a UX convenience only — the
 * backend is the single source of truth for authorization (every protected
 * endpoint re-checks the role server-side). `roles` uses canonical DB values
 * ('admin', 'agent', 'customer').
 */
export default function RequireRole({ roles, children }) {
  const { isAuthenticated, role } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (roles && !roles.includes(role)) {
    return (
      <div className="state state--error" role="alert">
        <p className="state__title">Not authorized</p>
        <p>This area is restricted to: {roles.join(', ')}.</p>
      </div>
    );
  }
  return children;
}
