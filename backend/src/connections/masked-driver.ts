import type { IDatabaseDriver } from '../drivers/driver.interface';

/** Null out masked columns on one row object (mutates). */
function maskRow(row: unknown, masked: Set<string>): void {
  if (!row || typeof row !== 'object') return;
  const r = row as Record<string, unknown>;
  for (const col of masked) if (col in r) r[col] = null;
}

function maskRows(rows: unknown, masked: Set<string>): void {
  if (Array.isArray(rows)) for (const r of rows) maskRow(r, masked);
}

/**
 * Wraps a driver so a user's column masks are applied to EVERY row it returns,
 * whatever the caller does with it.
 *
 * SECURITY: masking used to be applied by each caller, at only three of ~40
 * driver call sites — so it held on the grid, the SQL editor and exports, and
 * silently leaked everywhere else (FK peek, cursor streaming, federated
 * queries, the public API, shared queries, dashboard tiles, scheduled reports).
 * A control that every new read path has to remember to re-apply is a control
 * that will keep failing, so it lives here instead: get the driver through
 * `buildDriverForRole(..., { userId })` and masked columns simply cannot come
 * back.
 *
 * Owners have no ColumnMask rows, so `masked` is empty for them and this is a
 * pass-through.
 */
export function wrapDriverWithMasks(raw: IDatabaseDriver, masked: Set<string>): IDatabaseDriver {
  if (masked.size === 0) return raw;

  // Every method that can return row values. Anything not listed returns
  // metadata (schemas, DDL, indexes) and is passed through untouched.
  const ROW_METHODS = new Set([
    'getTableData',
    'runRawQuery',
    'fetchRowByPk',
    'insertRow',
    'updateRow',
    'generateRows',
  ]);

  return new Proxy(raw, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string' || !ROW_METHODS.has(prop)) {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (...args: unknown[]) => {
        const out = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        if (out == null) return out;
        if (Array.isArray(out)) {
          maskRows(out, masked);
        } else if (typeof out === 'object') {
          const o = out as Record<string, unknown>;
          // { rows: [...] } shape (getTableData / runRawQuery)
          if (Array.isArray(o.rows)) maskRows(o.rows, masked);
          // a bare row object (fetchRowByPk / insertRow / updateRow)
          else maskRow(o, masked);
        }
        return out;
      };
    },
  });
}
