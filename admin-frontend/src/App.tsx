import { Navigate, Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './lib/api';
import Shell from './components/Shell';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Users from './pages/Users';
import UserDetail from './pages/UserDetail';
import Workspaces from './pages/Workspaces';
import Billing from './pages/Billing';
import Audit from './pages/Audit';
import Operators from './pages/Operators';
import Feedback from './pages/Feedback';
import Announcements from './pages/Announcements';
import EmailTemplates from './pages/EmailTemplates';
import Analytics from './pages/Analytics';
import Invites from './pages/Invites';
import Abuse from './pages/Abuse';
import Flags from './pages/Flags';
import Retention from './pages/Retention';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me(), retry: false });
  if (me.isLoading) {
    return <div className="h-screen flex items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }
  if (me.error) return <Navigate to="/login" replace />;
  return <Shell>{children}</Shell>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<RequireAuth><Dashboard /></RequireAuth>} />
      <Route path="/analytics" element={<RequireAuth><Analytics /></RequireAuth>} />
      <Route path="/users" element={<RequireAuth><Users /></RequireAuth>} />
      <Route path="/users/:id" element={<RequireAuth><UserDetail /></RequireAuth>} />
      <Route path="/workspaces" element={<RequireAuth><Workspaces /></RequireAuth>} />
      <Route path="/billing" element={<RequireAuth><Billing /></RequireAuth>} />
      <Route path="/feedback" element={<RequireAuth><Feedback /></RequireAuth>} />
      <Route path="/announcements" element={<RequireAuth><Announcements /></RequireAuth>} />
      <Route path="/email-templates" element={<RequireAuth><EmailTemplates /></RequireAuth>} />
      <Route path="/invites" element={<RequireAuth><Invites /></RequireAuth>} />
      <Route path="/abuse" element={<RequireAuth><Abuse /></RequireAuth>} />
      <Route path="/flags" element={<RequireAuth><Flags /></RequireAuth>} />
      <Route path="/retention" element={<RequireAuth><Retention /></RequireAuth>} />
      <Route path="/audit" element={<RequireAuth><Audit /></RequireAuth>} />
      <Route path="/operators" element={<RequireAuth><Operators /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
