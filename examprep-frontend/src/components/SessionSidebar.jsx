import StatusBadge from './StatusBadge';

/**
 * Left rail: the user's sessions, newest first, plus create/rename/delete and
 * the account footer.
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
    <div className="w-72 bg-gray-900 text-white flex flex-col flex-shrink-0 h-screen">
      <div className="p-4 border-b border-gray-800">
        <h1 className="text-lg font-bold">ChunkAI</h1>
        <p className="text-xs text-gray-400">Log intelligence</p>
        {isGuest && (
          <span className="inline-block mt-1 px-2 py-0.5 text-xs bg-emerald-600 rounded-full text-white">
            Demo Mode
          </span>
        )}
      </div>

      {!isGuest && (
        <div className="p-3">
          <button
            onClick={onCreate}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium bg-indigo-600 rounded-lg hover:bg-indigo-700"
          >
            <span className="text-base leading-none">＋</span> New session
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 space-y-1">
        {sessions.length === 0 && (
          <p className="text-xs text-gray-500 text-center mt-6 px-2">
            {isGuest ? 'Loading demo session...' : 'No sessions yet. Create one to upload logs.'}
          </p>
        )}
        {sessions.map((s) => (
          <div
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={`group rounded-lg px-3 py-2 cursor-pointer transition-colors ${
              s.id === currentId ? 'bg-gray-800' : 'hover:bg-gray-800/50'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium truncate">{s.title}</span>
              {!isGuest && (
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => rename(e, s)}
                    title="Rename"
                    className="text-gray-400 hover:text-white text-xs px-1"
                  >
                    ✎
                  </button>
                  <button
                    onClick={(e) => remove(e, s)}
                    title="Delete"
                    className="text-gray-400 hover:text-red-400 text-xs px-1"
                  >
                    🗑
                  </button>
                </div>
              )}
            </div>
            <div className="mt-1">
              <StatusBadge status={s.analysisStatus} />
            </div>
          </div>
        ))}
      </div>

      <div className="p-3 border-t border-gray-800">
        <p className="text-xs text-gray-400 truncate mb-2" title={email}>
          {email}
        </p>
        <button
          onClick={onLogout}
          className="w-full px-3 py-2 text-sm font-medium text-gray-200 bg-gray-800 rounded-lg hover:bg-gray-700"
        >
          {isGuest ? 'Exit Demo' : 'Log out'}
        </button>
      </div>
    </div>
  );
}
