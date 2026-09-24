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

  // One-click demo: no credentials to type. Every call provisions a fresh
  // anonymous guest, so two visitors never share an identity. With `roomCode`
  // the guest joins that room (a shared link); without it they get a new room.
  async function guestLogin(roomCode) {
    const { data } = await api.post('/auth/demo', roomCode ? { roomCode } : {});
    persist(data);
    return data.roomCode;
  }

  // Turn this guest session into a real account. The server keeps the same user
  // id, so the rooms and history built in the demo come with it; all that
  // changes is the credentials — and the token that carries them.
  //
  // The address is not trusted yet: the response carries a `verification` block
  // naming the address a confirmation link went to, and the caller shows a
  // "check your inbox" state rather than pretending the account is finished.
  async function claimAccount({ name, email, password }) {
    const { data } = await api.post('/auth/claim', { name, email, password });
    persist(data);
    return { user: data.user, verification: data.verification };
  }

  // Send another confirmation link. The server answers the same way whether or
  // not the address is awaiting one, so the caller must not treat the response
  // as proof the account exists.
  async function resendVerification(email) {
    const { data } = await api.post('/auth/resend-verification', { email });
    return data;
  }

  // Spend the link from a confirmation email. Public by nature: the link is
  // often opened somewhere with no session, so it does not sign anyone in — it
  // only proves the address. If it happens to belong to the signed-in user, the
  // stored profile is refreshed so the banner clears.
  async function verifyEmail(token) {
    const { data } = await api.post('/auth/verify-email', { token });
    const stored = localStorage.getItem('intellimeet_user');
    if (stored) {
      const current = JSON.parse(stored);
      if (current?.id && data.user?.id && String(current.id) === String(data.user.id)) {
        const refreshed = { ...current, emailVerified: true, email: data.user.email };
        localStorage.setItem('intellimeet_user', JSON.stringify(refreshed));
        setUser(refreshed);
      }
    }
    return data.user;
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
    <AuthContext.Provider
      value={{
        user,
        token,
        ready,
        login,
        signup,
        guestLogin,
        claimAccount,
        resendVerification,
        verifyEmail,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
