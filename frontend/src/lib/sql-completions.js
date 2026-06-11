/**
 * Monaco SQL completion provider bound to a live connection's schema.
 *
 * Strategy:
 *   - Fetch the connection's ER graph once on mount (cheap — same endpoint
 *     the Schema tab uses; cached server-side).
 *   - Register a completion-item provider that offers: SQL keywords,
 *     table names (qualified + bare), column names (after `table.`), and
 *     JOIN-completion suggestions derived from FK edges.
 *   - Disposed on unmount so multiple SQL tabs don't stack providers.
 *
 * This is intentionally *not* a full LSP: no type-aware expression
 * completion, no parser-driven scope narrowing. The shape below catches
 * 80% of what users actually tab-complete.
 */
const SQL_KEYWORDS = [
    "SELECT",
    "FROM",
    "WHERE",
    "AND",
    "OR",
    "NOT",
    "IS",
    "NULL",
    "IN",
    "BETWEEN",
    "LIKE",
    "ILIKE",
    "ORDER BY",
    "GROUP BY",
    "HAVING",
    "LIMIT",
    "OFFSET",
    "JOIN",
    "LEFT JOIN",
    "RIGHT JOIN",
    "INNER JOIN",
    "OUTER JOIN",
    "FULL JOIN",
    "CROSS JOIN",
    "ON",
    "AS",
    "DISTINCT",
    "COUNT",
    "SUM",
    "AVG",
    "MIN",
    "MAX",
    "UNION",
    "UNION ALL",
    "INTERSECT",
    "EXCEPT",
    "WITH",
    "INSERT INTO",
    "VALUES",
    "UPDATE",
    "SET",
    "DELETE FROM",
    "CASE",
    "WHEN",
    "THEN",
    "ELSE",
    "END",
    "TRUE",
    "FALSE",
    "NOW()",
    "CURRENT_TIMESTAMP",
];
export function registerSqlCompletions(monaco, getEr) {
    return monaco.languages.registerCompletionItemProvider("sql", {
        triggerCharacters: [".", " ", ","],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        provideCompletionItems(model, position) {
            const er = getEr();
            if (!er)
                return { suggestions: [] };
            const word = model.getWordUntilPosition(position);
            const range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn,
            };
            const prefixRaw = model.getValueInRange({
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: 1,
                endColumn: position.column,
            });
            const prefix = prefixRaw.toUpperCase();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const suggestions = [];
            // 1) Qualified column: saw `foo.` → offer columns of the table `foo`.
            const dotMatch = /([A-Za-z_][A-Za-z0-9_]*)\.$/.exec(prefixRaw);
            if (dotMatch) {
                const tableName = dotMatch[1].toLowerCase();
                const table = er.nodes.find((t) => t.name.toLowerCase() === tableName ||
                    `${t.schema}.${t.name}`.toLowerCase() === tableName);
                if (table) {
                    for (const c of table.columns) {
                        suggestions.push({
                            label: c.name,
                            kind: monaco.languages.CompletionItemKind.Field,
                            insertText: c.name,
                            detail: `${c.type}${c.pk ? " PK" : ""}`,
                            range,
                        });
                    }
                    return { suggestions };
                }
            }
            // 2) After FROM / JOIN / INTO / UPDATE — offer tables.
            const inTableContext = /\b(FROM|JOIN|INTO|UPDATE|DELETE FROM)\s+$/.test(prefix) ||
                /\b(FROM|JOIN|INTO|UPDATE|DELETE FROM)\s+[A-Za-z_][A-Za-z0-9_]*$/.test(prefix);
            if (inTableContext) {
                for (const t of er.nodes) {
                    suggestions.push({
                        label: t.name,
                        kind: monaco.languages.CompletionItemKind.Struct,
                        insertText: t.schema === "public" ? t.name : `${t.schema}.${t.name}`,
                        detail: `${t.schema}.${t.name}`,
                        documentation: `${t.columns.length} columns`,
                        range,
                    });
                }
                // JOIN on FK: after `JOIN <tbl> ` suggest `ON tbl.col = other.col`.
                const joinMatch = /\bJOIN\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(prefix);
                if (joinMatch) {
                    const target = joinMatch[1].toLowerCase();
                    // Find nodes whose name matches target, then look at edges touching them.
                    const node = er.nodes.find((n) => n.name.toLowerCase() === target);
                    if (node) {
                        for (const e of er.edges) {
                            if (e.source !== node.id && e.target !== node.id)
                                continue;
                            const other = e.source === node.id
                                ? er.nodes.find((n) => n.id === e.target)
                                : er.nodes.find((n) => n.id === e.source);
                            if (!other)
                                continue;
                            const srcCol = e.columns?.[0] ?? "id";
                            const refCol = e.refColumns?.[0] ?? "id";
                            const text = e.source === node.id
                                ? `ON ${node.name}.${srcCol} = ${other.name}.${refCol}`
                                : `ON ${other.name}.${srcCol} = ${node.name}.${refCol}`;
                            suggestions.push({
                                label: text,
                                kind: monaco.languages.CompletionItemKind.Snippet,
                                insertText: text,
                                detail: "FK-derived join",
                                range,
                            });
                        }
                    }
                }
                return { suggestions };
            }
            // 3) Default: keywords + table names + all column names from all tables.
            for (const kw of SQL_KEYWORDS) {
                suggestions.push({
                    label: kw,
                    kind: monaco.languages.CompletionItemKind.Keyword,
                    insertText: kw,
                    range,
                });
            }
            for (const t of er.nodes) {
                suggestions.push({
                    label: t.name,
                    kind: monaco.languages.CompletionItemKind.Struct,
                    insertText: t.name,
                    detail: `${t.schema}.${t.name}`,
                    range,
                });
            }
            // Dedupe column names across tables.
            const seen = new Set();
            for (const t of er.nodes) {
                for (const c of t.columns) {
                    if (seen.has(c.name))
                        continue;
                    seen.add(c.name);
                    suggestions.push({
                        label: c.name,
                        kind: monaco.languages.CompletionItemKind.Field,
                        insertText: c.name,
                        detail: `${c.type} (${t.name})`,
                        range,
                    });
                }
            }
            return { suggestions };
        },
    });
}
