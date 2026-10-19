import { Link } from 'react-router-dom';
import { REPO_URL } from '../config';
import { useGuestLaunch } from '../hooks/useGuestLaunch';
import Icon, { Logo } from './Icon';

// Shared frame of the public pages (landing, benchmarks): header, footer, sections.

export function SiteHeader({ links = [] }) {
  const { launch, busy, user } = useGuestLaunch();
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-paper/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link to="/" aria-label="DeepLogLens home">
          <Logo />
        </Link>
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

export function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-slate-500 sm:flex-row sm:px-6">
        <Logo />
        <div className="flex items-center gap-5">
          <Link to="/benchmarks" className="hover:text-violet-700">
            Benchmarks
          </Link>
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 hover:text-violet-700">
            <Icon name="github" className="h-4 w-4" /> Source
          </a>
        </div>
      </div>
    </footer>
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
      <h2 className="mt-3 font-display text-3xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-[2.6rem]">{title}</h2>
      {lead && <p className="mt-4 text-base leading-relaxed text-slate-600">{lead}</p>}
    </div>
  );
}
