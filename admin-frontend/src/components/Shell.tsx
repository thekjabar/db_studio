import { NavLink, useNavigate } from 'react-router-dom';
import {
  BarChart3, Users, Briefcase, DollarSign, ClipboardList, ShieldCheck, LogOut,
  MessageSquare, Megaphone, Mail, AlertOctagon, TrendingUp, Ticket, Database, Flag,
} from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useModal } from '@/components/modal-provider';

const nav = [
  { to: '/', label: 'Dashboard', icon: BarChart3, end: true },
  { to: '/analytics', label: 'Analytics', icon: TrendingUp },
  { to: '/users', label: 'Users', icon: Users },
  { to: '/workspaces', label: 'Workspaces', icon: Briefcase },
  { to: '/billing', label: 'Billing', icon: DollarSign },
  { to: '/feedback', label: 'Feedback', icon: MessageSquare },
  { to: '/announcements', label: 'Announcements', icon: Megaphone },
  { to: '/email-templates', label: 'Email templates', icon: Mail },
  { to: '/invites', label: 'Invites', icon: Ticket },
  { to: '/abuse', label: 'Abuse', icon: AlertOctagon },
  { to: '/flags', label: 'Feature flags', icon: Flag },
  { to: '/retention', label: 'Retention', icon: Database },
  { to: '/audit', label: 'Audit log', icon: ClipboardList },
  { to: '/operators', label: 'Operators', icon: ShieldCheck },
];

export default function Shell({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const modal = useModal();

  const logout = async () => {
    const ok = await modal.confirm({
      title: 'Log out?',
      description: 'You will be signed out of the operator console.',
      confirmLabel: 'Log out',
    });
    if (!ok) return;
    await api.logout().catch(() => {});
    qc.clear();
    toast.success('Logged out');
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-screen flex">
      <aside className="w-56 shrink-0 border-r border-border bg-card flex flex-col">
        <div className="h-14 px-4 flex items-center gap-2 border-b border-border">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <span className="font-semibold text-sm">DB Studio Admin</span>
        </div>
        <nav className="p-2 space-y-0.5 flex-1">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-muted transition-colors',
                  isActive && 'bg-muted text-primary',
                )
              }
            >
              <n.icon className="h-4 w-4" /> {n.label}
            </NavLink>
          ))}
        </nav>
        <button
          onClick={logout}
          className="border-t border-border px-4 py-3 text-sm text-muted-foreground hover:text-foreground flex items-center gap-2"
        >
          <LogOut className="h-4 w-4" /> Log out
        </button>
      </aside>
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
