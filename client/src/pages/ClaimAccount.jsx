import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

/**
 * Where a guest session becomes a real account.
 *
 * The server keeps the same user id, so every room, message and AI summary built
 * during the demo is already theirs — this only attaches credentials to it.
 */
export default function ClaimAccount() {
  const { user, claimAccount } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Set once the claim lands and the address is waiting for its link. The
  // session is already real by then, so this is a success state, not an error.
  const [pending, setPending] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { verification } = await claimAccount({ name, email, password });
      if (verification?.required) {
        setPending(verification);
      } else {
        navigate('/');
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save your account. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (pending) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <h1>Check your inbox</h1>
          <p className="sub">
            We sent a confirmation link to <strong>{pending.email}</strong>. Open it to finish
            setting up your account — until then you can keep using everything you built here, but
            the new email and password won&apos;t sign you in yet.
          </p>
          {pending.delivered === false && (
            <div className="form-error">
              We couldn&apos;t deliver that email just now. Ask for another link in a moment.
            </div>
          )}
          <button className="btn btn-primary" onClick={() => navigate('/')}>
            Back to my meetings
          </button>
          <div className="form-switch">Didn&apos;t get it? Ask again from your dashboard.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1>Save your session</h1>
        <p className="sub">
          You're taking part as <strong>{user?.name}</strong>. Add an email and password and
          everything you made here — rooms, chat and AI summaries — becomes a real account you can
          log back into.
        </p>

        {error && <div className="form-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="name">Your name</label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={user?.name || 'Your name'}
              autoComplete="name"
            />
          </div>
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
              autoComplete="new-password"
            />
            <div className="field-hint">At least 8 characters</div>
          </div>
          <button className="btn btn-primary" type="submit" disabled={loading}>
            {loading ? 'Saving…' : 'Create my account'}
          </button>
        </form>

        <div className="form-switch">
          <Link to="/">Not now — back to my meetings</Link>
        </div>
      </div>
    </div>
  );
}
