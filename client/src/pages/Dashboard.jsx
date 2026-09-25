import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/axios';
import { useAuth } from '../context/AuthContext.jsx';
import { exportFilename, matchesQuery, meetingToMarkdown } from '../lib/export.js';

export default function Dashboard() {
  const { user, logout, resendVerification } = useAuth();
  const navigate = useNavigate();

  const [resent, setResent] = useState(false);
  const [resending, setResending] = useState(false);
  // A claimed account keeps working, but its address is inert until the link
  // sent to it comes back. This is where that nudge lives.
  const needsVerification = user && user.emailVerified === false;

  async function handleResend() {
    setResending(true);
    try {
      await resendVerification(user.email);
      setResent(true);
    } finally {
      setResending(false);
    }
  }

  const [title, setTitle] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [meetings, setMeetings] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  const visible = meetings.filter((meeting) => matchesQuery(meeting, query));

  useEffect(() => {
    loadMeetings();
  }, []);

  async function loadMeetings() {
    try {
      const { data } = await api.get('/meetings');
      setMeetings(data);
    } catch (err) {
      setError('Could not load your meetings.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e) {
    e.preventDefault();
    if (!title.trim()) return;
    setError('');
    try {
      const { data } = await api.post('/meetings', { title });
      navigate(`/room/${data.roomCode}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create meeting.');
    }
  }

  /**
   * Save one meeting as Markdown.
   *
   * A Blob and a click on a synthetic anchor — the whole of the download, kept
   * here rather than in `lib/export.js` so that what the tests cover is the
   * document itself instead of the DOM plumbing around it.
   */
  function handleExport(meeting) {
    const markdown = meetingToMarkdown(meeting);
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = exportFilename(meeting);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function handleJoin(e) {
    e.preventDefault();
    const code = joinCode.trim().toLowerCase();
    if (!code) return;
    setError('');
    try {
      await api.get(`/meetings/room/${code}`);
      navigate(`/room/${code}`);
    } catch (err) {
      setError(err.response?.data?.error || 'No meeting found with that room code.');
    }
  }

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          IntellMeet
        </div>
        <div className="topbar-right">
          <span>{user?.name}</span>
          <button className="btn btn-secondary" onClick={logout}>
            Log out
          </button>
        </div>
      </header>

      <div className="dashboard">
        <div className="dashboard-header">
          <div>
            <h1>Your meetings</h1>
            <p>Start a new room, join with a code, or revisit a past summary.</p>
          </div>
        </div>

        {user?.isGuest && (
          <div className="panel guest-panel">
            <div>
              <h2>You&apos;re in a guest session</h2>
              <p>Add an email and password to keep these meetings for good.</p>
            </div>
            <button className="btn btn-mint" onClick={() => navigate('/claim')}>
              Save this session
            </button>
          </div>
        )}

        {needsVerification && (
          <div className="panel guest-panel">
            <div>
              <h2>Confirm your email</h2>
              <p>
                {resent
                  ? `If ${user.email} is waiting for confirmation, a new link is on its way.`
                  : `We sent a confirmation link to ${user.email}. Open it to finish setting up your account — until then that address won't sign you in.`}
              </p>
            </div>
            {!resent && (
              <button className="btn btn-mint" onClick={handleResend} disabled={resending}>
                {resending ? 'Sending…' : 'Resend link'}
              </button>
            )}
          </div>
        )}

        {error && <div className="form-error">{error}</div>}

        <div className="panel">
          <h2>Start a new meeting</h2>
          <form className="inline-form" onSubmit={handleCreate}>
            <input
              placeholder="Meeting title, e.g. Sprint planning"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <button className="btn btn-mint" type="submit">
              Start meeting
            </button>
          </form>
        </div>

        <div className="panel">
          <h2>Join with a room code</h2>
          <form className="inline-form" onSubmit={handleJoin}>
            <input
              placeholder="e.g. xk3-mfqp-czr"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
            />
            <button className="btn btn-secondary" type="submit">
              Join
            </button>
          </form>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>History</h2>
            {meetings.length > 0 && (
              <input
                className="search-input"
                type="search"
                placeholder="Search title, room code or status…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            )}
          </div>
          {loading ? (
            <div className="empty-state">Loading…</div>
          ) : meetings.length === 0 ? (
            <div className="empty-state">No meetings yet — start one above.</div>
          ) : visible.length === 0 ? (
            <div className="empty-state">
              No meetings match “{query}” — {meetings.length} in your history.
            </div>
          ) : (
            <ul className="meeting-list">
              {query && (
                <li className="field-hint">
                  {visible.length} of {meetings.length} shown.
                </li>
              )}
              {visible.map((m) => (
                <li key={m._id} className="meeting-row">
                  <div>
                    <div className="meeting-title">{m.title}</div>
                    <div className="meeting-meta">
                      {m.roomCode} · {new Date(m.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span
                      className={`status-pill ${m.status === 'ended' ? 'status-ended' : 'status-live'}`}
                    >
                      {m.status}
                    </span>
                    <button
                      className="btn btn-secondary"
                      onClick={() => handleExport(m)}
                      title="Save the summary, action items and chat as Markdown"
                    >
                      Export .md
                    </button>
                    <button
                      className="btn btn-secondary"
                      onClick={() => navigate(`/room/${m.roomCode}`)}
                    >
                      {m.status === 'ended' ? 'View' : 'Rejoin'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
