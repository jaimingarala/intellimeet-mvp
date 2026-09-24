import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

export default function AuthPage({ mode }) {
  const isLogin = mode === 'login';
  const { login, signup, guestLogin, resendVerification } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [guestLoading, setGuestLoading] = useState(false);
  // Set when login is refused because the address is still waiting for its
  // confirmation link. That state only appears to someone who already holds
  // the password, so it leaks nothing.
  const [unverifiedEmail, setUnverifiedEmail] = useState('');
  const [resent, setResent] = useState(false);
  const [resending, setResending] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setUnverifiedEmail('');
    setResent(false);
    setLoading(true);
    try {
      if (isLogin) {
        await login(email, password);
      } else {
        await signup(name, email, password);
      }
      navigate('/');
    } catch (err) {
      const data = err.response?.data || {};
      if (data.code === 'email_unverified') {
        setUnverifiedEmail(data.email || email);
      }
      setError(data.error || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    setResending(true);
    try {
      await resendVerification(unverifiedEmail);
      setResent(true);
    } finally {
      setResending(false);
    }
  }

  async function handleDemo() {
    setError('');
    setGuestLoading(true);
    try {
      const roomCode = await guestLogin();
      navigate(roomCode ? `/room/${roomCode}` : '/');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not start the demo. Please try again.');
    } finally {
      setGuestLoading(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1>{isLogin ? 'Welcome back' : 'Create your account'}</h1>
        <p className="sub">
          {isLogin
            ? 'Sign in to join or start a meeting.'
            : 'Set up IntellMeet for your team in under a minute.'}
        </p>

        {error && <div className="form-error">{error}</div>}

        {unverifiedEmail &&
          (resent ? (
            <div className="form-note">
              If <strong>{unverifiedEmail}</strong> is waiting for confirmation, a new link is on
              its way.
            </div>
          ) : (
            <button
              className="btn btn-secondary"
              type="button"
              onClick={handleResend}
              disabled={resending}
            >
              {resending ? 'Sending…' : 'Send me a new confirmation link'}
            </button>
          ))}

        <form onSubmit={handleSubmit}>
          {!isLogin && (
            <div className="field">
              <label htmlFor="name">Full name</label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoComplete="name"
              />
            </div>
          )}
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete={isLogin ? 'current-password' : 'new-password'}
            />
          </div>
          <button className="btn btn-primary" type="submit" disabled={loading || guestLoading}>
            {loading ? 'Please wait…' : isLogin ? 'Log in' : 'Sign up'}
          </button>
        </form>

        <div className="demo-divider">or</div>

        <button
          className="btn btn-mint demo-btn"
          type="button"
          onClick={handleDemo}
          disabled={loading || guestLoading}
        >
          {guestLoading ? 'Opening your demo room…' : 'Try the demo — no sign-up'}
        </button>
        <p className="demo-note">
          Opens your own guest room with video, chat and AI summaries. Share the link to invite someone.
        </p>

        <div className="form-switch">
          {isLogin ? (
            <>
              New to IntellMeet? <Link to="/signup">Create an account</Link>
            </>
          ) : (
            <>
              Already have an account? <Link to="/login">Log in</Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
