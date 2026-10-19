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
    <div className="hidden h-full w-72 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
      <div className="flex items-center justify-between border-b border-slate-100 p-4">
        <Link to="/">
          <Logo />
        </Link>
        {isGuest && (
          <span className="rounded-full bg-gradient-to-r from-violet-600 to-pink-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
            Demo
          </span>
        )}
      </div>

      {!isGuest && (
        <div className="p-3">
          <button onClick={onCreate} className="btn-primary w-full">
            <Icon name="plus" className="h-4 w-4" /> New session
          </button>
        </div>
      )}

      <p className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Sessions</p>
      <div className="flex-1 space-y-1 overflow-y-auto px-2">
        {sessions.length === 0 && (
          <p className="mt-6 px-2 text-center text-xs text-slate-400">
            {isGuest ? 'Loading demo session...' : 'No sessions yet. Create one to upload logs.'}
          </p>
        )}
        {sessions.map((s) => (
          <div
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={`group cursor-pointer rounded-xl px-3 py-2.5 transition ${
              s.id === currentId ? 'bg-violet-50 ring-1 ring-violet-200' : 'hover:bg-slate-50'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium text-slate-800">{s.title}</span>
              {!isGuest && (
                <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <button onClick={(e) => rename(e, s)} title="Rename" className="px-1 text-xs text-slate-400 hover:text-slate-700">
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

      <div className="border-t border-slate-100 p-3">
        <p className="mb-2 truncate text-xs text-slate-500" title={email}>
          {email}
        </p>
        <button onClick={onLogout} className="btn-secondary w-full py-2">
          <Icon name="logout" className="h-4 w-4" /> {isGuest ? 'Exit demo' : 'Log out'}
        </button>
      </div>
    </div>
  );
}
