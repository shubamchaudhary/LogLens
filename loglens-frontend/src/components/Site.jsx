import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useGuestLaunch } from '../hooks/useGuestLaunch';
import Icon, { Logo } from './Icon';

// Shared frame of the public pages (landing, benchmarks): header and sections.

/** `back`: show a Back button (to the previous page in the app, or home). */
export function SiteHeader({ links = [], back = false }) {
  const { launch, busy, user } = useGuestLaunch();
  const navigate = useNavigate();
  const location = useLocation();
  // 'default' means this page was opened directly, so there is no in-app page to go back to.
  const goBack = () => (location.key === 'default' ? navigate('/') : navigate(-1));
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-paper/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          {back && (
            <button onClick={goBack} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:border-violet-300 hover:text-violet-700">
              <Icon name="arrowRight" className="h-4 w-4 rotate-180" /> Back
            </button>
          )}
          <Link to="/" aria-label="DeepLogLens home">
            <Logo />
          </Link>
        </div>
        <nav className="hidden items-center gap-7 text-sm text-slate-600 md:flex">
          {links.map(([href, label]) =>
            href.startsWith('/') ? (
              <Link key={href} to={href} className="hover:text-violet-700">
                {label}
              </Link>
            ) : (
              <a key={href} href={href} className="hover:text-violet-700">
                {label}
              </a>
            )
          )}
        </nav>
        <div className="flex items-center gap-2">
          {!user && (
            <Link to="/login" className="btn-ghost hidden text-sm sm:inline-flex">
              Sign in
            </Link>
          )}
          <button onClick={launch} disabled={busy} className="btn-primary px-4 py-2">
            {user ? 'Open app' : 'Try as guest'} <Icon name="arrowRight" className="h-4 w-4" />
          </button>
        </div>
      </div>
    </header>
  );
}

export function Section({ id, children, className = '' }) {
  return (
    <section id={id} className={`scroll-mt-16 border-t border-line py-20 ${className}`}>
      <div className="mx-auto max-w-6xl px-4 sm:px-6">{children}</div>
    </section>
  );
}

export function Heading({ kicker, title, lead }) {
  return (
    <div className="max-w-3xl">
      <p className="kicker">{kicker}</p>
      <h2 className="mt-3 font-display text-3xl font-extrabold leading-tight tracking-tight text-ink sm:text-[2.6rem]">{title}</h2>
      {lead && <p className="mt-4 text-base leading-relaxed text-slate-600">{lead}</p>}
    </div>
  );
}
