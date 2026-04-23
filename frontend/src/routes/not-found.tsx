import { Link, useLocation } from "react-router-dom";
import { ArrowLeft, Database, Home } from "lucide-react";
import { useAuth } from "@/lib/auth-store";

export default function NotFoundPage() {
  const loc = useLocation();
  const accessToken = useAuth((s) => s.accessToken);

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header className="h-14 flex items-center px-6 border-b border-border bg-card/50">
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <Database className="h-5 w-5 text-primary" />
          DB Studio
        </Link>
      </header>

      <main className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="max-w-md w-full text-center space-y-6">
          <div className="text-7xl font-bold text-primary/30 tracking-tight">404</div>
          <div>
            <h1 className="text-2xl font-semibold">Page not found</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              We couldn't find anything at{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{loc.pathname}</code>.
              It may have been moved, renamed, or never existed.
            </p>
          </div>
          <div className="flex items-center justify-center gap-2 flex-wrap pt-2">
            <button
              type="button"
              onClick={() => window.history.back()}
              className="inline-flex items-center gap-1.5 border border-border hover:bg-accent rounded-md px-4 py-2 text-sm"
            >
              <ArrowLeft className="h-4 w-4" /> Go back
            </button>
            <Link
              to={accessToken ? "/connections" : "/"}
              className="inline-flex items-center gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-4 py-2 text-sm font-medium"
            >
              <Home className="h-4 w-4" />
              {accessToken ? "Your connections" : "Home"}
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
