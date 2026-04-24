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

function RequireAuth({ children }: { children: React.ReactNode }) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me(), retry: false });
  if (me.isLoading) {
    return <div className="h-screen flex items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">Loading…</div>;
  }
  if (me.error) return <Navigate to="/login" replace />;
  return <Shell>{children}</Shell>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<RequireAuth><Dashboard /></RequireAuth>} />
      <Route path="/users" element={<RequireAuth><Users /></RequireAuth>} />
      <Route path="/users/:id" element={<RequireAuth><UserDetail /></RequireAuth>} />
      <Route path="/workspaces" element={<RequireAuth><Workspaces /></RequireAuth>} />
      <Route path="/billing" element={<RequireAuth><Billing /></RequireAuth>} />
      <Route path="/audit" element={<RequireAuth><Audit /></RequireAuth>} />
      <Route path="/operators" element={<RequireAuth><Operators /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
