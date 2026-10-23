import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { FormProblem } from '../components/States.jsx';

/**
 * Public customer sign-up. Creates a CUSTOMER account via POST
 * /api/auth/register — the backend fixes the role, so no role control exists
 * here (FR-AUTH-05). Client-side checks mirror the server Zod rules to give
 * instant feedback, but the server remains the authority: its rejection is
 * surfaced verbatim through FormProblem. A submitting guard prevents accidental
 * double submissions.
 */

// Mirrors backend validators.js: email ≤255, name 1..120,
// password ≥10 with at least one letter and one digit.
function validate({ name, email, password, confirm }) {
  const errs = {};
  if (!name.trim()) errs.name = 'Name is required';
  else if (name.trim().length > 120) errs.name = 'Name must not exceed 120 characters';

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()))
    errs.email = 'A valid email address is required';
  else if (email.length > 255) errs.email = 'Email must not exceed 255 characters';

  if (password.length < 10) errs.password = 'Password must be at least 10 characters long';
  else if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password))
    errs.password = 'Password must contain at least one letter and one digit';
  else if (password.length > 128) errs.password = 'Password must not exceed 128 characters';

  if (confirm !== password) errs.confirm = 'Passwords do not match';
  return errs;
}

export default function RegisterPage() {
  const { register, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from || '/products';

  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' });
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  if (isAuthenticated) return <Navigate to={from} replace />;

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    if (submitting) return; // guard against duplicate submissions
    const errs = validate(form);
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSubmitting(true);
    setError(null);
    try {
      await register({
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
      });
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
        <h1 className="page__title">Create your account</h1>
        <p className="page__subtitle">
          Self-service sign-up creates a customer account for placing orders. Staff accounts (admin,
          order manager) are provisioned by an administrator.
        </p>
      </header>

      <section className="card">
        <form className="form" onSubmit={handleSubmit} aria-label="registration form" noValidate>
          <label>
            Full name
            <input
              type="text"
              name="name"
              value={form.name}
              onChange={set('name')}
              autoComplete="name"
              maxLength={120}
              aria-invalid={Boolean(fieldErrors.name)}
              aria-describedby={fieldErrors.name ? 'err-name' : undefined}
              required
            />
          </label>
          {fieldErrors.name ? (
            <p id="err-name" className="form__field-error" role="alert">
              {fieldErrors.name}
            </p>
          ) : null}

          <label>
            Email
            <input
              type="email"
              name="email"
              value={form.email}
              onChange={set('email')}
              autoComplete="email"
              aria-invalid={Boolean(fieldErrors.email)}
              aria-describedby={fieldErrors.email ? 'err-email' : undefined}
              required
            />
          </label>
          {fieldErrors.email ? (
            <p id="err-email" className="form__field-error" role="alert">
              {fieldErrors.email}
            </p>
          ) : null}

          <label>
            Password
            <input
              type="password"
              name="password"
              value={form.password}
              onChange={set('password')}
              autoComplete="new-password"
              aria-invalid={Boolean(fieldErrors.password)}
              aria-describedby={fieldErrors.password ? 'err-password' : 'pw-hint'}
              required
            />
          </label>
          {fieldErrors.password ? (
            <p id="err-password" className="form__field-error" role="alert">
              {fieldErrors.password}
            </p>
          ) : (
            <p id="pw-hint" className="form__hint">
              At least 10 characters, including a letter and a number.
            </p>
          )}

          <label>
            Confirm password
            <input
              type="password"
              name="confirm"
              value={form.confirm}
              onChange={set('confirm')}
              autoComplete="new-password"
              aria-invalid={Boolean(fieldErrors.confirm)}
              aria-describedby={fieldErrors.confirm ? 'err-confirm' : undefined}
              required
            />
          </label>
          {fieldErrors.confirm ? (
            <p id="err-confirm" className="form__field-error" role="alert">
              {fieldErrors.confirm}
            </p>
          ) : null}

          <FormProblem error={error} />

          <button type="submit" className="btn" disabled={submitting}>
            {submitting ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <p className="hint">
          Already have an account?{' '}
          <Link to="/login" className="btn btn--link">
            Log in
          </Link>
        </p>
      </section>

      <Link to="/" className="btn btn--secondary">
        ← Back to home
      </Link>
    </main>
  );
}
