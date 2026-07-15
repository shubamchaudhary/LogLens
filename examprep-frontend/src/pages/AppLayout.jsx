import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { sessionAPI } from '../services/api';
import SessionSidebar from '../components/SessionSidebar';
import SessionWorkspace from '../components/SessionWorkspace';

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

  const loadSessions = useCallback(async (selectId) => {
    try {
      const { data } = await sessionAPI.list();
      const list = data || [];
      setSessions(list);
      setCurrentId((prev) => {
        if (selectId) return selectId;
        if (prev && list.some((s) => s.id === prev)) return prev;
        return list.length ? list[0].id : null;
      });
    } catch (e) {
      console.error('Failed to load sessions', e);
    } finally {
      setLoading(false);
    }
  }, []);

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

  const current = sessions.find((s) => s.id === currentId) || null;

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-gray-500">Loading…</div>;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      <SessionSidebar
        sessions={sessions}
        currentId={currentId}
        onSelect={setCurrentId}
        onCreate={handleCreate}
        onRename={handleRename}
        onDelete={handleDelete}
        email={user?.email}
        onLogout={logout}
      />

      {current ? (
        <SessionWorkspace key={current.id} session={current} onStatusChange={patchSession} />
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <h2 className="text-lg font-semibold text-gray-800">No session selected</h2>
            <p className="text-sm text-gray-500 mt-1 mb-4">
              Create a session to upload logs and run the analysis pipeline.
            </p>
            <button
              onClick={handleCreate}
              className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium"
            >
              New session
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
