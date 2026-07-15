import { createContext, useContext, useState, useEffect } from 'react';
import { authAPI } from '../services/api';

const AuthContext = createContext();

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (token) {
      const guestSessionId = localStorage.getItem('guestSessionId');
      const isGuest = localStorage.getItem('isGuest') === 'true';
      setUser({ token, guestSessionId, isGuest });
    }
    setLoading(false);
  }, [token]);

  const login = async (email, password) => {
    try {
      const response = await authAPI.login({ email, password });
      const { token, userId, email: userEmail } = response.data;
      localStorage.setItem('token', token);
      localStorage.removeItem('guestSessionId');
      localStorage.removeItem('isGuest');
      setToken(token);
      setUser({ userId, email: userEmail, token });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.response?.data?.message || 'Login failed' };
    }
  };

  const guestLogin = async () => {
    try {
      const response = await authAPI.guest();
      const { token, guestSessionId } = response.data;
      localStorage.setItem('token', token);
      localStorage.setItem('guestSessionId', guestSessionId);
      localStorage.setItem('isGuest', 'true');
      setToken(token);
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
      setToken(token);
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
    setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, token, login, guestLogin, register, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
};

