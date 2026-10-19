import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/auth';
import AuthShell from '../components/AuthShell';

/** Sign-in page: guest access first (no account needed), then email and password. */
export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [guestLoading, setGuestLoading] = useState(false);
  const { login, guestLogin } = useAuth();
  const navigate = useNavigate();

  // Load remembered email
  useEffect(() => {
    const remembered = localStorage.getItem('rememberedEmail');
    if (remembered) {
      setEmail(remembered);
      setRememberMe(true);
    }
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    // Client-side validation
    if (!email.trim()) {
      setError('Please enter your email address');
      setLoading(false);
      return;
    }

    if (!password) {
      setError('Please enter your password');
      setLoading(false);
      return;
    }

    try {
      const result = await login(email.trim().toLowerCase(), password);

      if (result.success) {
        // Handle remember me
        if (rememberMe) {
          localStorage.setItem('rememberedEmail', email.trim().toLowerCase());
        } else {
          localStorage.removeItem('rememberedEmail');
        }
        navigate('/app');
      } else {
        setError(result.error || 'Login failed. Please check your credentials.');
      }
    } catch {
      setError('Connection error. Please check your internet connection.');
    } finally {
      setLoading(false);
    }
  };

  const handleGuestLogin = async () => {
    setError('');
    setGuestLoading(true);
    try {
      const result = await guestLogin();
      if (result.success) {
        navigate('/app');
      } else {
        setError(result.error || 'Guest login is not available right now.');
      }
    } catch {
      setError('Connection error. Please check your internet connection.');
    } finally {
      setGuestLoading(false);
    }
  };

  return (
    <AuthShell title="Sign in" subtitle="Analyse your own logs, or look around as a guest first.">
      <div className="panel border-accent/40 p-5">
        <p className="kicker">Fastest way in</p>
        <p className="mt-2 font-semibold text-ink">Guest analysis on a 1 GB log</p>
        <p className="mt-0.5 text-sm text-muted">No account. 5.4M lines, six outages, live Q&amp;A.</p>
        <button onClick={handleGuestLogin} disabled={guestLoading || loading} className="btn-primary mt-4 w-full py-3">
          {guestLoading ? <Spinner label="Opening…" /> : 'Continue as guest'}
        </button>
      </div>

      <div className="my-7 flex items-center gap-3 text-xs text-dim">
        <span className="h-px flex-1 bg-line" /> or sign in with email <span className="h-px flex-1 bg-line" />
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-500">{error}</div>}

        <div>
          <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-ink">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            className="input border-line bg-surface text-ink placeholder:text-dim"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={loading}
          />
        </div>

        <div>
          <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-ink">
            Password
          </label>
          <div className="relative">
            <input
              id="password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              required
              className="input border-line bg-surface pr-16 text-ink placeholder:text-dim"
              placeholder="Your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
            />
            <button
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted hover:text-ink"
              onClick={() => setShowPassword(!showPassword)}
            >
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-body">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-line accent-violet-600"
            checked={rememberMe}
            onChange={(e) => setRememberMe(e.target.checked)}
          />
          Remember me
        </label>

        <button type="submit" disabled={loading} className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-line bg-surface py-3 text-sm font-semibold text-ink transition hover:border-accent/40 hover:text-accent disabled:opacity-50">
          {loading ? <Spinner label="Signing in…" dark /> : 'Sign in'}
        </button>
      </form>

      <p className="mt-6 text-sm text-body">
        New here?{' '}
        <Link to="/register" className="font-semibold text-accent hover:underline">
          Create an account
        </Link>
      </p>
    </AuthShell>
  );
}

function Spinner({ label, dark = false }) {
  return (
    <>
      <svg className={`h-4 w-4 animate-spin ${dark ? 'text-accent' : 'text-white'}`} fill="none" viewBox="0 0 24 24" aria-hidden="true">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      {label}
    </>
  );
}
