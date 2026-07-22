import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { api, getToken, setToken } from "./api";

type Row = Record<string, unknown>;

export default function App() {
  const [authed, setAuthed] = useState<boolean>(!!getToken());
  const [me, setMe] = useState<any>(null);

  useEffect(() => {
    if (!authed) return;
    api.me().then((r) => setMe(r.body)).catch(() => { setToken(null); setAuthed(false); });
  }, [authed]);

  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return <Workbench me={me} onLogout={() => { setToken(null); setAuthed(false); setMe(null); }} />;
}

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const { body } = await api.login(email, password);
      setToken((body as any).accessToken);
      onDone();
    } catch (e: any) {
      setErr(e.message || "Login failed");
    } finally { setBusy(false); }
  };

  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <div className="brand">Query Schema <span className="v2">v2</span></div>
        <div className="sub">Rust + React (Bun) benchmark build</div>
        <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        <input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {err && <div className="err">{err}</div>}
        <button disabled={busy}>{busy ? "…" : "Sign in"}</button>
        <div className="hint">Same account as v1 — argon2 verified in Rust.</div>
      </form>
    </div>
  );
}

function Workbench({ me, onLogout }: { me: any; onLogout: () => void }) {
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schema, setSchema] = useState<string>("public");
  const [tables, setTables] = useState<string[]>([]);
  const [table, setTable] = useState<string>("");
  const [view, setView] = useState<"browse" | "sql">("browse");
  const [rows, setRows] = useState<Row[]>([]);
  const [cols, setCols] = useState<string[]>([]);
  const [timing, setTiming] = useState<{ tookMs?: number; clientMs?: number; rowCount?: number; total?: number | null }>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [sql, setSql] = useState("SELECT * FROM \"User\" LIMIT 100;");

  useEffect(() => {
    api.schemas().then((r) => {
      const s = r.body.schemas;
      setSchemas(s);
      if (!s.includes("public") && s[0]) setSchema(s[0]);
    }).catch((e) => setErr(e.message));
  }, []);

  useEffect(() => {
    if (!schema) return;
    api.tables(schema).then((r) => setTables(r.body.tables)).catch((e) => setErr(e.message));
  }, [schema]);

  const openTable = useCallback(async (t: string) => {
    setTable(t); setView("browse"); setLoading(true); setErr("");
    try {
      const r = await api.rows(schema, t, 100, 0);
      const data = r.body.rows || [];
      setRows(data);
      setCols(data[0] ? Object.keys(data[0]) : []);
      setTiming({ tookMs: r.body.tookMs, clientMs: r.clientMs, rowCount: r.body.rowCount, total: r.body.total });
    } catch (e: any) { setErr(e.message); setRows([]); setCols([]); }
    finally { setLoading(false); }
  }, [schema]);

  const runSql = useCallback(async () => {
    setLoading(true); setErr(""); setView("sql");
    try {
      const r = await api.run(sql);
      const data = r.body.rows || [];
      setRows(data);
      setCols(r.body.columns?.length ? r.body.columns : data[0] ? Object.keys(data[0]) : []);
      setTiming({ tookMs: r.body.tookMs, clientMs: r.clientMs, rowCount: r.body.rowCount });
    } catch (e: any) { setErr(e.message); setRows([]); setCols([]); }
    finally { setLoading(false); }
  }, [sql]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Query Schema <span className="v2">v2</span> <span className="badge">Rust</span></div>
        <div className="spacer" />
        <div className="who">{me?.email}</div>
        <button className="ghost" onClick={onLogout}>Sign out</button>
      </header>
      <div className="body">
        <aside className="side">
          <label className="lbl">Schema</label>
          <select value={schema} onChange={(e) => setSchema(e.target.value)}>
            {schemas.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <label className="lbl">Tables ({tables.length})</label>
          <div className="tablelist">
            {tables.map((t) => (
              <button key={t} className={t === table ? "on" : ""} onClick={() => openTable(t)}>{t}</button>
            ))}
          </div>
          <div className="sqlbtn">
            <button className={view === "sql" ? "on" : ""} onClick={() => setView("sql")}>SQL runner</button>
          </div>
        </aside>
        <main className="main">
          {view === "sql" && (
            <div className="sqlpane">
              <textarea value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false} />
              <div className="sqlbar">
                <button onClick={runSql} disabled={loading}>{loading ? "Running…" : "Run"}</button>
                <Timing timing={timing} />
              </div>
            </div>
          )}
          {view === "browse" && (
            <div className="browsebar">
              <div className="title">{table ? `${schema}.${table}` : "Pick a table"}</div>
              <Timing timing={timing} />
            </div>
          )}
          {err && <div className="err main-err">{err}</div>}
          <Grid cols={cols} rows={rows} loading={loading} />
        </main>
      </div>
    </div>
  );
}

function Timing({ timing }: { timing: { tookMs?: number; clientMs?: number; rowCount?: number; total?: number | null } }) {
  if (timing.tookMs == null) return null;
  return (
    <div className="timing">
      <span className="metric"><b>{timing.tookMs.toFixed(1)}</b> ms server</span>
      <span className="metric"><b>{timing.clientMs?.toFixed(0)}</b> ms round-trip</span>
      <span className="metric">{timing.rowCount ?? 0} rows{timing.total != null ? ` / ${timing.total}` : ""}</span>
    </div>
  );
}

function Grid({ cols, rows, loading }: { cols: string[]; rows: Row[]; loading: boolean }) {
  // Cap DOM rows — the benchmark is the backend; the grid just displays.
  const shown = useMemo(() => rows.slice(0, 500), [rows]);
  if (loading) return <div className="empty">Loading…</div>;
  if (!rows.length) return <div className="empty">No rows</div>;
  return (
    <div className="gridwrap">
      <table className="grid">
        <thead>
          <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => <td key={c}>{fmt(r[c])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}
