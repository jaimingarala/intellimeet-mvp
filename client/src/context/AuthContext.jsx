import { createContext, useContext, useEffect, useState } from 'react';
import api from '../api/axios';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => localStorage.getItem('intellimeet_token'));
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const storedUser = localStorage.getItem('intellimeet_user');
    if (token && storedUser) {
      setUser(JSON.parse(storedUser));
    }
    setReady(true);
  }, [token]);

  async function login(email, password) {
    const { data } = await api.post('/auth/login', { email, password });
    persist(data);
  }

  async function signup(name, email, password) {
    const { data } = await api.post('/auth/signup', { name, email, password });
    persist(data);
  }

  function persist(data) {
    localStorage.setItem('intellimeet_token', data.token);
    localStorage.setItem('intellimeet_user', JSON.stringify(data.user));
    setToken(data.token);
    setUser(data.user);
  }

  function logout() {
    localStorage.removeItem('intellimeet_token');
    localStorage.removeItem('intellimeet_user');
    setToken(null);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, token, ready, login, signup, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
