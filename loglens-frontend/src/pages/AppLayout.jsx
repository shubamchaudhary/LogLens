import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/auth';
import { sessionAPI } from '../services/api';
import { resetDemo } from '../demo/demoApi';
import SessionSidebar from '../components/SessionSidebar';
import SessionWorkspace from '../components/SessionWorkspace';
import Icon, { Logo } from '../components/Icon';

/**
 * v2 shell: a sidebar of the user's log-analysis sessions and a workspace for
 * the selected one. Session status badges stay live via updates bubbled up from
 * the workspace's progress stream.
 */
export default function AppLayout() {
  const { user, logout } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [replayKey, setReplayKey] = useState(0);

  const isGuest = user?.isGuest === true;
  const guestSessionId = user?.guestSessionId;

  const loadSessions = useCallback(async (selectId) => {
    try {
      const { data } = await sessionAPI.list();
      const list = data || [];
      setSessions(list);
      setCurrentId((prev) => {
        // Guest mode: always land on the demo session.
        if (isGuest && guestSessionId) return guestSessionId;
        if (selectId) return selectId;
        if (prev && list.some((s) => s.id === prev)) return prev;
        return list.length ? list[0].id : null;
      });
    } catch (e) {
      console.error('Failed to load sessions', e);
    } finally {
      setLoading(false);
    }
  }, [isGuest, guestSessionId]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const handleCreate = async () => {
    try {
      const { data } = await sessionAPI.create();
      await loadSessions(data.id);
    } catch (e) {
      console.error('Failed to create session', e);
    }
  };

  const handleRename = async (id, title) => {
    try {
      await sessionAPI.rename(id, title);
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
    } catch (e) {
      console.error('Failed to rename session', e);
    }
  };

  const handleDelete = async (id) => {
    try {
      await sessionAPI.remove(id);
    } catch (e) {
      console.error('Failed to delete session', e);
      return;
    }
    setCurrentId((prev) => (prev === id ? null : prev));
    await loadSessions();
  };

  // Keep the sidebar badge for a session in sync with its live progress.
  const patchSession = useCallback((patch) => {
    setSessions((prev) => prev.map((s) => (s.id === patch.id ? { ...s, ...patch } : s)));
  }, []);

  // Demo only: wipe the finished replay and run it again from the upload step.
  const handleReplay = async () => {
    resetDemo();
    await loadSessions();
    setReplayKey((k) => k + 1);
  };

  const current = sessions.find((s) => s.id === currentId) || null;

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-slate-500">Loading…</div>;
  }

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden md:flex-row">
      {/* Phone/tablet top bar; the sidebar takes over from md up. */}
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5 md:hidden">
        <Link to="/">
          <Logo />
        </Link>
        <button onClick={logout} className="btn-ghost">
          <Icon name="logout" className="h-3.5 w-3.5" /> {isGuest ? 'Exit demo' : 'Log out'}
        </button>
      </div>

      <SessionSidebar
        sessions={sessions}
        currentId={currentId}
        onSelect={setCurrentId}
        onCreate={isGuest ? undefined : handleCreate}
        onRename={isGuest ? undefined : handleRename}
        onDelete={isGuest ? undefined : handleDelete}
        email={isGuest ? 'Guest (Demo)' : user?.email}
        onLogout={logout}
        isGuest={isGuest}
      />

      {current ? (
        <SessionWorkspace
          key={`${current.id}:${replayKey}`}
          session={current}
          onStatusChange={patchSession}
          onReplay={user?.isDemo ? handleReplay : undefined}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <h2 className="text-lg font-semibold text-slate-800">No session selected</h2>
            <p className="mb-4 mt-1 text-sm text-slate-500">
              {isGuest
                ? 'The demo session is loading...'
                : 'Create a session to upload logs and run the analysis pipeline.'}
            </p>
            {!isGuest && (
              <button onClick={handleCreate} className="btn-primary">
                <Icon name="plus" className="h-4 w-4" /> New session
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
