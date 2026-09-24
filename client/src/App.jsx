import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import AuthPage from './pages/AuthPage.jsx';
import ClaimAccount from './pages/ClaimAccount.jsx';
import Dashboard from './pages/Dashboard.jsx';
import MeetingRoom from './pages/MeetingRoom.jsx';
import VerifyEmail from './pages/VerifyEmail.jsx';

function ProtectedRoute({ children }) {
  const { user, ready } = useAuth();
  if (!ready) return null;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

/** Claiming only makes sense for a guest; a real account has nothing to claim. */
function GuestRoute({ children }) {
  const { user, ready } = useAuth();
  if (!ready) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (!user.isGuest) return <Navigate to="/" replace />;
  return children;
}

/**
 * A room link is how a second person joins without an account, so an
 * unauthenticated visitor here becomes an anonymous guest *in this room* rather
 * than being bounced to the login page.
 */
function GuestRoomJoin({ roomCode }) {
  const { guestLogin } = useAuth();
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    // React StrictMode runs effects twice in development, which would create two
    // guests; the ref keeps it to one.
    if (started.current) return;
    started.current = true;
    guestLogin(roomCode).catch((err) => {
      setError(err.response?.data?.error || 'Could not open that room.');
    });
  }, [guestLogin, roomCode]);

  if (error) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <h1>Room unavailable</h1>
          <p className="sub">{error}</p>
          <Link className="btn btn-primary" to="/login">
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1>Joining as a guest…</h1>
        <p className="sub">Setting up an anonymous identity for this room.</p>
      </div>
    </div>
  );
}

function RoomRoute() {
  const { user, ready } = useAuth();
  const { roomCode } = useParams();
  if (!ready) return null;
  if (!user) return <GuestRoomJoin roomCode={roomCode} />;
  return <MeetingRoom />;
}

export default function App() {
  return (
    <div className="app-shell">
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/signup" element={<AuthPage mode="signup" />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/claim"
          element={
            <GuestRoute>
              <ClaimAccount />
            </GuestRoute>
          }
        />
        {/* Public: a confirmation link is often opened where there is no session. */}
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/room/:roomCode" element={<RoomRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
