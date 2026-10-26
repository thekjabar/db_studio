/**
 * Find the `:named` parameters in a SQL statement.
 *
 * This mirrors the scanner the API uses to bind them (`sqlparams.rs`): the same
 * things must be ignored on both sides, or the editor asks for a value the
 * server never binds (or worse, the reverse). Not parameters:
 *
 *   `id::text` (a cast) · `'12:30'` (string literal) · `"a:b"` (quoted ident)
 *   `-- note: x` and `/* note: x *\/` (comments) · `$$ body :x $$` (dollar quote)
 *   `arr[1:2]` (a slice — nothing identifier-like follows the colon)
 */
export function sqlParamNames(sql: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  let i = 0;

  const isWord = (c: string) => /[A-Za-z0-9_]/.test(c);

  while (i < sql.length) {
    const c = sql[i];

    // String literal or quoted identifier.
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Line comment.
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    // Block comment (nests in Postgres).
    if (c === "/" && sql[i + 1] === "*") {
      let depth = 0;
      while (i < sql.length) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
          continue;
        }
        if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
          if (depth === 0) break;
          continue;
        }
        i++;
      }
      continue;
    }
    // Dollar-quoted body: $tag$ … $tag$
    if (c === "$") {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? sql.length : end + tag.length;
        continue;
      }
    }
    // `::` is a cast, never the start of a name.
    if (c === ":" && sql[i + 1] === ":") {
      i += 2;
      continue;
    }
    // A parameter.
    if (c === ":" && sql[i + 1] && /[A-Za-z_]/.test(sql[i + 1])) {
      let end = i + 1;
      while (end < sql.length && isWord(sql[end])) end++;
      const name = sql.slice(i + 1, end);
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
      i = end;
      continue;
    }
    i++;
  }
  return names;
}

/**
 * Turn what the user typed into the JSON the API binds.
 *
 * The API picks the SQL cast from the JSON type, so this is where "1000" stops
 * being a string and becomes a number. An empty box is NULL — the useful
 * default for an optional filter. Anything that is not plainly a number, a
 * boolean or null stays a string, including dates (the API recognises ISO dates
 * and casts them for you).
 */
export function coerceParam(raw: string): string | number | boolean | null {
  const t = raw.trim();
  if (t === "") return null;
  if (t.toLowerCase() === "null") return null;
  if (t.toLowerCase() === "true") return true;
  if (t.toLowerCase() === "false") return false;
  // Plain numbers only: not "1,000", not "007" (an id that must stay a string),
  // not "1e5" dressed up as a code.
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}

export function buildParams(
  names: string[],
  values: Record<string, string>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const n of names) out[n] = coerceParam(values[n] ?? "");
  return out;
}
