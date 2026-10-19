import { createContext, useContext } from 'react';

// Kept apart from AuthContext.jsx so that file only exports a component
// (React fast refresh requirement).
export const AuthContext = createContext();

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};
