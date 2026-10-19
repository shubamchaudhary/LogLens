// Build-time switches (Vite env) shared by the UI.

// 'replay' (default): "View demo" runs entirely in the browser, replaying the
// pipeline on a sample log from src/demo/fixture.json. No backend needed.
// 'live': "View demo" logs in to the backend's guest session (POST /auth/guest).
export const GUEST_MODE = import.meta.env.VITE_GUEST_MODE === 'live' ? 'live' : 'replay';

export const REPO_URL = 'https://github.com/shubamchaudhary/LogLens';
