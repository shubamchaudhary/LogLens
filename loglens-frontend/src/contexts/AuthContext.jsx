import { useState } from 'react';
import { authAPI } from '../services/api';
import { AuthContext } from './auth';
import { GUEST_MODE } from '../config';
import { enterDemo, exitDemo, isDemo } from '../demo/demoMode';

function storedUser() {
  const token = localStorage.getItem('token');
  if (!token) return null;
  const isGuest = localStorage.getItem('isGuest') === 'true';
  // A guest token saved before the replay demo existed points at the live
  // backend; in replay mode send that visitor to the demo instead.
  if (isGuest && GUEST_MODE === 'replay' && !isDemo()) enterDemo();
  return {
    token,
    guestSessionId: localStorage.getItem('guestSessionId'),
    isGuest,
    isDemo: isDemo(),
  };
}

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(storedUser);
  const loading = false;

  const login = async (email, password) => {
    try {
      const response = await authAPI.login({ email, password });
      const { token, userId, email: userEmail } = response.data;
      localStorage.setItem('token', token);
      localStorage.removeItem('guestSessionId');
      localStorage.removeItem('isGuest');
      exitDemo();
      setUser({ userId, email: userEmail, token });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.response?.data?.message || 'Login failed' };
    }
  };

  const guestLogin = async () => {
    if (GUEST_MODE === 'replay') {
      // The demo runs in the browser against the bundled fixture; no backend call.
      enterDemo();
      localStorage.setItem('token', 'demo');
      localStorage.setItem('isGuest', 'true');
      localStorage.removeItem('guestSessionId');
      setUser({ token: 'demo', guestSessionId: null, isGuest: true, isDemo: true });
      return { success: true };
    }
    try {
      const response = await authAPI.guest();
      const { token, guestSessionId } = response.data;
      localStorage.setItem('token', token);
      localStorage.setItem('guestSessionId', guestSessionId);
      localStorage.setItem('isGuest', 'true');
      setUser({ token, guestSessionId, isGuest: true });
      return { success: true };
    } catch (error) {
      const msg = error.response?.data || 'Guest login unavailable';
      return { success: false, error: typeof msg === 'string' ? msg : 'Guest login failed' };
    }
  };

  const register = async (email, password, fullName) => {
    try {
      const response = await authAPI.register({ email, password, fullName });
      const { token, userId, email: userEmail } = response.data;
      localStorage.setItem('token', token);
      exitDemo();
      setUser({ userId, email: userEmail, token });
      return { success: true };
    } catch (error) {
      // Better error handling - show detailed error information
      let errorMessage = 'Registration failed';
      
      if (error.response) {
        // Server responded with error
        const status = error.response.status;
        if (status === 403) {
          errorMessage = 'Access forbidden. Please check CORS configuration and backend is running.';
        } else if (status === 401) {
          errorMessage = 'Authentication failed. Please check your credentials.';
        } else if (status === 400) {
          errorMessage = error.response.data?.message || 'Invalid request. Please check your input.';
        } else if (status >= 500) {
          errorMessage = 'Server error. Please try again later.';
        } else {
          errorMessage = error.response.data?.message || `Error: ${status} ${error.response.statusText}`;
        }
      } else if (error.request) {
        // Request made but no response (network error, backend down, etc.)
        if (error.code === 'ERR_NETWORK' || error.code === 'ECONNREFUSED') {
          errorMessage = 'Cannot connect to server. Please check if backend is running.';
        } else if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
          errorMessage = 'Connection timeout. Server may be slow or unreachable.';
        } else {
          errorMessage = `Network error: ${error.message || 'Cannot reach server'}`;
        }
      } else {
        errorMessage = error.message || 'An unexpected error occurred';
      }
      
      console.error('Registration error details:', {
        message: error.message,
        code: error.code,
        response: error.response?.data,
        status: error.response?.status,
        statusText: error.response?.statusText,
      });
      
      return { success: false, error: errorMessage };
    }
  };

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('guestSessionId');
    localStorage.removeItem('isGuest');
    exitDemo();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, token: user?.token ?? null, login, guestLogin, register, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
};

