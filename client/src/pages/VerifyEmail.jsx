import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

/**
 * Where a confirmation link lands.
 *
 * Public on purpose: the link is usually opened on whichever device has the
 * inbox, which is often not the browser that claimed the account. Spending it
 * only proves the address — it deliberately does not sign anyone in, so a
 * forwarded email can't be traded for a session.
 */
export default function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const { verifyEmail, resendVerification } = useAuth();

  const [state, setState] = useState('verifying'); // verifying | done | failed
  const [message, setMessage] = useState('');
  const [code, setCode] = useState('');
  // Prefilled from the server when it knows which address the link belonged to.
  const [email, setEmail] = useState('');
  const [resent, setResent] = useState(false);
  const [resending, setResending] = useState(false);

  // StrictMode runs effects twice; the token is single-use, so the second call
  // would report "already used" for a link that just worked.
  const spent = useRef(false);

  useEffect(() => {
    if (spent.current) return;
    spent.current = true;

    if (!token) {
      setState('failed');
      setCode('verification_invalid');
      setMessage('That link is missing its confirmation code. Request a new one below.');
      return;
    }

    verifyEmail(token)
      .then(() => setState('done'))
      .catch((err) => {
        const data = err.response?.data || {};
        setState('failed');
        setCode(data.code || '');
        setMessage(data.error || 'That confirmation link is not valid.');
        if (data.email) setEmail(data.email);
      });
  }, [token, verifyEmail]);

  async function handleResend(e) {
    e.preventDefault();
    if (!email.trim()) return;
    setResending(true);
    try {
      await resendVerification(email);
      setResent(true);
    } catch {
      setResent(true); // the server's answer is the same either way; keep it so
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        {state === 'verifying' && (
          <>
            <h1>Confirming your email…</h1>
            <p className="sub">One moment while we check that link.</p>
          </>
        )}

        {state === 'done' && (
          <>
            <h1>Email confirmed</h1>
            <p className="sub">
              Your address is verified. You can log in with it now — everything you built in the
              demo is still attached to your account.
            </p>
            <Link className="btn btn-primary" to="/login">
              Go to log in
            </Link>
          </>
        )}

        {state === 'failed' && (
          <>
            <h1>That link didn&apos;t work</h1>
            <p className="sub">{message}</p>

            {resent ? (
              <div className="form-note">
                If <strong>{email}</strong> is waiting for confirmation, a new link is on its way.
              </div>
            ) : (
              <form onSubmit={handleResend}>
                <div className="field">
                  <label htmlFor="email">Email</label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    autoComplete="email"
                  />
                </div>
                <button className="btn btn-primary" type="submit" disabled={resending}>
                  {resending ? 'Sending…' : 'Send a new link'}
                </button>
              </form>
            )}

            <div className="form-switch">
              {code === 'verification_expired' ? 'The link had expired. ' : ''}
              <Link to="/login">Back to log in</Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
