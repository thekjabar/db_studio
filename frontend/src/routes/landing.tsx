import { Link } from "react-router-dom";
import {
  ArrowRight,
  BookOpen,
  Camera,
  Database,
  History,
  Key,
  LayoutDashboard,
  Mail,
  Send,
  ShieldCheck,
  Sparkles,
  Table2,
  Timer,
  Webhook,
  Workflow,
} from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { useAuth } from "@/lib/auth-store";

const features = [
  {
    icon: Table2,
    title: "Every dialect, one UI",
    body: "Postgres, MySQL, SQL Server, SQLite. Same keyboard shortcuts, same data grid, same joins across them in a single query.",
  },
  {
    icon: Sparkles,
    title: "AI SQL assistant",
    body: "Describe what you want. Get back a query you can read, edit, and share. Schema passed as context so suggestions actually hit real tables.",
  },
  {
    icon: LayoutDashboard,
    title: "Dashboards from queries",
    body: "Pin a saved query to a chart. Line, bar, area, pie. No drag-and-drop report builder — just SQL in, chart out.",
  },
  {
    icon: ShieldCheck,
    title: "Role-based access",
    body: "Workspaces, per-connection roles (owner/editor/viewer), per-table grants, column masking. No surprises in prod.",
  },
  {
    icon: Timer,
    title: "Scheduled queries",
    body: "Cron your SQL, email the CSV. Slow-query log captures anything over a threshold, grouped by shape.",
  },
  {
    icon: Webhook,
    title: "Webhooks",
    body: "POST JSON when a watched row changes. HMAC-signed, retried with backoff.",
  },
  {
    icon: Workflow,
    title: "Multi-DB joins",
    body: "Join tables across two connections with DuckDB under the hood. Query MySQL + Postgres + SQLite in the same SELECT.",
  },
  {
    icon: Key,
    title: "API keys",
    body: "Scripts talk to the same engine your UI talks to. Scoped, revocable, rate-limited.",
  },
  {
    icon: BookOpen,
    title: "Audit + revert",
    body: "Every row change is logged with before/after. One click to roll back a bad UPDATE.",
  },
  {
    icon: ShieldCheck,
    title: "SSO for workspaces",
    body: "Bring your own IdP. OpenID Connect for Okta, Azure AD, Google Workspace, Auth0, Keycloak — configured per workspace.",
  },
  {
    icon: History,
    title: "Team query history",
    body: "See what the team ran, when, and against which connection. Filter by user, action, or SQL text. Open any query back in the editor.",
  },
  {
    icon: Camera,
    title: "Diff-mode migrations",
    body: "Snapshot your schema before a change, then generate the ALTER statements that take it to the current live state.",
  },
  {
    icon: Send,
    title: "One-click result delivery",
    body: "Send any query's result to email, Slack, or an HTTPS webhook — without scheduling it. CSV for email, previewed tables for Slack.",
  },
  {
    icon: Mail,
    title: "Self-serve password + email",
    body: "Password reset, email verification, per-email login cooldown, and SMTP-aware fallback for single-user self-hosts.",
  },
];

export default function LandingPage() {
  const accessToken = useAuth((s) => s.accessToken);
  const isAuthed = !!accessToken;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="h-14 flex items-center justify-between px-6 border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-20">
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <Database className="h-5 w-5 text-primary" />
          DB Studio
        </Link>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          {isAuthed ? (
            <Link
              to="/connections"
              className="text-sm bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 inline-flex items-center gap-1.5"
            >
              Open app <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          ) : (
            <>
              <Link
                to="/login"
                className="text-sm text-muted-foreground hover:text-foreground px-3 py-1.5"
              >
                Sign in
              </Link>
              <Link
                to="/signup"
                className="text-sm bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5"
              >
                Sign up
              </Link>
            </>
          )}
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-6 py-20 sm:py-28 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground mb-6">
          <Sparkles className="h-3 w-3" />
          Every tool a DB admin actually needs, in one place
        </div>
        <h1 className="text-4xl sm:text-6xl font-semibold tracking-tight">
          The database studio for teams who
          <br />
          <span className="text-primary">don't want five tools</span>.
        </h1>
        <p className="mt-6 text-lg text-muted-foreground max-w-2xl mx-auto">
          Browse, query, schedule, back up, and share work across Postgres, MySQL, SQL Server, and
          SQLite. One interface, role-aware, with an AI that actually knows your schema.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3 flex-wrap">
          {isAuthed ? (
            <Link
              to="/connections"
              className="inline-flex items-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-5 py-2.5 text-sm font-medium"
            >
              Go to your connections <ArrowRight className="h-4 w-4" />
            </Link>
          ) : (
            <>
              <Link
                to="/signup"
                className="inline-flex items-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-5 py-2.5 text-sm font-medium"
              >
                Get started free <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/login"
                className="inline-flex items-center gap-2 border border-border hover:bg-accent rounded-md px-5 py-2.5 text-sm"
              >
                Sign in
              </Link>
            </>
          )}
        </div>
      </section>

      {/* Feature grid */}
      <section className="max-w-6xl mx-auto px-6 pb-20">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {features.map((f) => (
            <div
              key={f.title}
              className="rounded-lg border border-border bg-card p-5 hover:border-primary/40 transition-colors"
            >
              <div className="h-8 w-8 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center mb-3">
                <f.icon className="h-4 w-4 text-primary" />
              </div>
              <div className="font-semibold mb-1">{f.title}</div>
              <div className="text-sm text-muted-foreground">{f.body}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Call out */}
      <section className="max-w-5xl mx-auto px-6 pb-24">
        <div className="rounded-xl border border-border bg-gradient-to-br from-primary/10 via-card to-card p-8 sm:p-12 text-center">
          <h2 className="text-2xl sm:text-3xl font-semibold">Open source. Self-hostable.</h2>
          <p className="mt-3 text-muted-foreground max-w-xl mx-auto">
            Run it in your infra, point it at your databases, give your team access. Connection
            credentials are encrypted with AES-256-GCM and never leave your server.
          </p>
          <div className="mt-6 flex items-center justify-center gap-3 flex-wrap">
            <Link
              to={isAuthed ? "/connections" : "/signup"}
              className="inline-flex items-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-5 py-2.5 text-sm font-medium"
            >
              {isAuthed ? "Open the app" : "Start using it"}
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-border text-xs text-muted-foreground py-6 text-center">
        © {new Date().getFullYear()} DB Studio
      </footer>
    </div>
  );
}
