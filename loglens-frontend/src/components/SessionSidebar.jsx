import { Link } from 'react-router-dom';
import StatusBadge from './StatusBadge';
import Icon, { Logo } from './Icon';

/**
 * Left rail: the user's sessions, newest first, plus create/rename/delete and
 * the account footer. Hidden below md; AppLayout shows a top bar there instead.
 */
export default function SessionSidebar({
  sessions,
  currentId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  email,
  onLogout,
  isGuest,
}) {
  const rename = (e, s) => {
    e.stopPropagation();
    const next = window.prompt('Rename session', s.title);
    if (next && next.trim() && next.trim() !== s.title) onRename(s.id, next.trim());
  };

  const remove = (e, s) => {
    e.stopPropagation();
    if (window.confirm(`Delete "${s.title}"? This removes its analysis permanently.`)) {
      onDelete(s.id);
    }
  };

  return (
    <div className="hidden h-full w-72 shrink-0 flex-col border-r border-line bg-surface md:flex">
      <div className="flex items-center justify-between border-b border-line p-4">
        <Link to="/">
          <Logo />
        </Link>
      </div>

      <div className="p-3">
        <button
          onClick={isGuest ? undefined : onCreate}
          disabled={isGuest}
          title={isGuest ? 'Sign in to create your own sessions' : undefined}
          className="btn-primary w-full"
        >
          <Icon name="plus" className="h-4 w-4" /> New session
        </button>
        {isGuest && <p className="mt-1.5 text-center text-[11px] text-slate-400">Sign in to analyse your own logs</p>}
      </div>

      <p className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Sessions</p>
      <div className="flex-1 space-y-1 overflow-y-auto px-2">
        {sessions.length === 0 && (
          <p className="mt-6 px-2 text-center text-xs text-slate-400">
            {isGuest ? 'Loading…' : 'No sessions yet. Create one to upload logs.'}
          </p>
        )}
        {sessions.map((s) => (
          <div
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={`group cursor-pointer rounded-xl px-3 py-2.5 transition ${
              s.id === currentId ? 'bg-accent-soft ring-1 ring-accent/30' : 'hover:bg-sand'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium text-ink">{s.title}</span>
              {!isGuest && (
                <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <button onClick={(e) => rename(e, s)} title="Rename" className="px-1 text-xs text-slate-400 hover:text-ink">
                    ✎
                  </button>
                  <button onClick={(e) => remove(e, s)} title="Delete" className="px-1 text-xs text-slate-400 hover:text-rose-500">
                    🗑
                  </button>
                </div>
              )}
            </div>
            <div className="mt-1.5">
              <StatusBadge status={s.analysisStatus} />
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-line p-3">
        <p className="mb-2 truncate text-xs text-muted" title={email}>
          {email}
        </p>
        <button onClick={onLogout} className="btn-secondary w-full py-2">
          <Icon name="logout" className="h-4 w-4" /> {isGuest ? 'Sign out' : 'Log out'}
        </button>
      </div>
    </div>
  );
}
