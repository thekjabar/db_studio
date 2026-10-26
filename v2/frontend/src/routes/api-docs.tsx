import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, Copy, Database, KeyRound, Terminal } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * How to drive Query Schema from a script.
 *
 * Deliberately inside the app rather than on the public site: the endpoints
 * below are only useful with a key, and the examples name a real connection
 * id, so this belongs behind the login with the keys themselves.
 */

const BASE = `${window.location.origin}/api/v1`;

function Code({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-md border border-border bg-muted/50 p-3 text-xs leading-relaxed">
        <code className="font-mono">{children}</code>
      </pre>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(children).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            },
            () => undefined,
          );
        }}
        className="absolute right-2 top-2 rounded border border-border bg-background/80 p-1 opacity-0 transition-opacity group-hover:opacity-100"
        aria-label="Copy"
      >
        {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  );
}

function Endpoint({
  method,
  path,
  summary,
  children,
}: {
  method: "GET" | "POST";
  path: string;
  summary: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={
            "rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold " +
            (method === "GET"
              ? "bg-sky-500/15 text-sky-600 dark:text-sky-400"
              : "bg-primary/15 text-primary")
          }
        >
          {method}
        </span>
        <code className="font-mono text-sm">{path}</code>
      </div>
      <p className="text-sm text-muted-foreground">{summary}</p>
      {children}
    </div>
  );
}

export default function ApiDocsRoute() {
  return (
    <div className="min-h-screen gradient-bg">
      <header className="flex h-14 items-center justify-between border-b border-border bg-card/50 px-6 backdrop-blur-sm">
        <Link to="/connections" className="flex items-center gap-2 font-semibold">
          <Database className="h-5 w-5 text-primary" />
          Query Schema
        </Link>
        <div className="flex items-center gap-3">
          <Link to="/api-keys" className="text-sm text-muted-foreground hover:text-foreground">
            API keys
          </Link>
          <Link to="/connections" className="text-sm text-muted-foreground hover:text-foreground">
            Connections
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto max-w-3xl space-y-8 p-6">
        <header className="space-y-2">
          <h1 className="text-xl font-semibold">Drive Query Schema from a script</h1>
          <p className="text-sm text-muted-foreground">
            Everything here is authenticated with an API key, not your login session. Create one
            under{" "}
            <Link to="/api-keys" className="text-primary hover:underline">
              API keys
            </Link>{" "}
            — a key can be scoped to particular connections, and it inherits your role, your row
            filters and your column masks. It is never a way around them.
          </p>
        </header>

        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <KeyRound className="h-4 w-4 text-primary" /> Authentication
          </h2>
          <p className="text-sm text-muted-foreground">
            Send the key as a bearer token. Base URL: <code className="font-mono">{BASE}</code>
          </p>
          <Code>{`curl ${BASE}/connections \\
  -H "Authorization: Bearer dbs_live_…"`}</Code>
          <p className="text-xs text-muted-foreground">
            120 requests per minute per key. Over that you get HTTP 429 with how long to wait. A
            revoked or expired key gets 401.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold">Endpoints</h2>

          <Endpoint
            method="GET"
            path="/api/v1/connections"
            summary="The connections this key may use. A scoped key lists only those it was created for."
          />

          <Endpoint
            method="GET"
            path="/api/v1/connections/:id/schemas"
            summary="Schema names in the database."
          />

          <Endpoint
            method="GET"
            path="/api/v1/connections/:id/tables?schema=public"
            summary="Tables in one schema."
          />

          <Endpoint
            method="POST"
            path="/api/v1/connections/:id/query"
            summary="Run SQL. VIEWER may only SELECT; a read-only connection refuses writes; DELETE / DROP / TRUNCATE / UPDATE need confirmDestructive."
          >
            <Code>{`curl -X POST ${BASE}/connections/<id>/query \\
  -H "Authorization: Bearer dbs_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "sql": "SELECT id, email FROM users WHERE created_at >= :since LIMIT 10",
    "params": { "since": "2026-01-01" },
    "maxRows": 1000
  }'`}</Code>
            <p className="text-xs text-muted-foreground">
              Values in <code className="font-mono">params</code> are bound, never pasted into the
              statement — a value cannot become SQL. Numbers, booleans, null and ISO dates are
              detected from the JSON type; anything else is text.
            </p>
            <Code>{`{
  "rows": [ { "id": 1, "email": "a@example.com" } ],
  "rowCount": 1,
  "fields": [ { "name": "id" }, { "name": "email" } ],
  "truncated": false,
  "durationMs": 12
}`}</Code>
          </Endpoint>
        </section>

        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Terminal className="h-4 w-4 text-primary" /> Command line
          </h2>
          <p className="text-sm text-muted-foreground">
            The same API with less typing. Node 18+ is the only requirement.
          </p>
          <Code>{`curl -fsSL https://api.queryschema.com/downloads/queryschema -o /usr/local/bin/queryschema
chmod +x /usr/local/bin/queryschema
export QUERYSCHEMA_TOKEN=dbs_live_…

queryschema connections ls
queryschema tables <connection-id> --schema public
queryschema query <connection-id> --sql "SELECT count(*) FROM users"

# parameters, and a CSV straight to a file
queryschema query <connection-id> \\
  --sql "SELECT * FROM orders WHERE created_at >= :since AND status = :status" \\
  --param since=2026-01-01 --param status=paid --format csv > orders.csv`}</Code>
          <p className="text-xs text-muted-foreground">
            Row counts and timings go to stderr, so a redirect captures only data. Configure a
            different host with <code className="font-mono">QUERYSCHEMA_URL</code>, or keep both in{" "}
            <code className="font-mono">~/.queryschema/config.json</code>.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold">What a key cannot do</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Reach a connection it was not scoped to, even one you can open in the app.</li>
            <li>See a column you are masked from, or a row your filters exclude.</li>
            <li>Run a write if your role on that connection is VIEWER.</li>
            <li>Sign in, change account settings, or manage other keys.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
