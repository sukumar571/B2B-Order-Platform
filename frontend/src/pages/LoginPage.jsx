import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { FormProblem } from '../components/States.jsx';

/**
 * Email + password login. Exchanges credentials for an in-memory access
 * token via AuthContext (POST /api/auth/login). The password check always
 * happens server-side — no credentials live in the UI.
 */
export default function LoginPage() {
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from || '/products';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  if (isAuthenticated) return <Navigate to={from} replace />;

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(email.trim(), password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="page page--narrow">
      <header className="page__header">
        <h1 className="page__title">Log in</h1>
        <p className="page__subtitle">
          Staff roles (admin, order manager) are required for the admin and inventory screens.
        </p>
      </header>

      <section className="card">
        <form className="form" onSubmit={handleSubmit} aria-label="login form">
          <label>
            Email
            <input
              type="email"
              name="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              name="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>

          <FormProblem error={error} />

          <button type="submit" className="btn" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Log in'}
          </button>
        </form>

        <p className="hint">
          Need an account to place orders?{' '}
          <Link to="/register" className="btn btn--link">
            Create one
          </Link>
        </p>
      </section>

      <Link to="/" className="btn btn--secondary">
        ← Back to home
      </Link>
    </main>
  );
}
