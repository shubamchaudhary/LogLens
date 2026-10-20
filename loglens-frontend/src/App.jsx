import { lazy, Suspense, useEffect, useRef } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { useAuth } from './contexts/auth';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Register from './pages/Register';
import Benchmarks from './pages/Benchmarks';

// The app shell (markdown renderer, tabs) loads on demand so the landing page stays light.
const AppLayout = lazy(() => import('./pages/AppLayout'));
const loadingScreen = <div className="min-h-screen flex items-center justify-center text-muted">Loading…</div>;

function PrivateRoute({ children }) {
  const { user, loading } = useAuth();
  
  if (loading) {
    return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  }
  
  return user ? children : <Navigate to="/login" />;
}

function PublicRoute({ children }) {
  const { user, loading } = useAuth();
  
  if (loading) {
    return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  }
  
  return !user ? children : <Navigate to="/app" />;
}

/** Shareable deep link (e.g. on a CV): /demo drops the visitor straight into the demo. */
function DemoEntry() {
  const { user, guestLogin } = useAuth();
  const started = useRef(false);
  useEffect(() => {
    if (user || started.current) return;
    started.current = true;
    guestLogin();
  }, [user, guestLogin]);
  return user ? <Navigate to="/app" replace /> : null;
}

function App() {
  return (
    <AuthProvider>
      <Router>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/demo" element={<DemoEntry />} />
          <Route path="/benchmarks" element={<Benchmarks />} />
          <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
          <Route path="/register" element={<PublicRoute><Register /></PublicRoute>} />
          <Route
            path="/app"
            element={
              <PrivateRoute>
                <Suspense fallback={loadingScreen}>
                  <AppLayout />
                </Suspense>
              </PrivateRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Router>
    </AuthProvider>
  );
}

export default App;
