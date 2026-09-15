import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/axios';
import { useAuth } from '../context/AuthContext.jsx';

export default function Dashboard() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const [title, setTitle] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [meetings, setMeetings] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

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
          <h2>History</h2>
          {loading ? (
            <div className="empty-state">Loading…</div>
          ) : meetings.length === 0 ? (
            <div className="empty-state">No meetings yet — start one above.</div>
          ) : (
            <ul className="meeting-list">
              {meetings.map((m) => (
                <li key={m._id} className="meeting-row">
                  <div>
                    <div className="meeting-title">{m.title}</div>
                    <div className="meeting-meta">
                      {m.roomCode} · {new Date(m.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span className={`status-pill ${m.status === 'ended' ? 'status-ended' : 'status-live'}`}>
                      {m.status}
                    </span>
                    <button className="btn btn-secondary" onClick={() => navigate(`/room/${m.roomCode}`)}>
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
