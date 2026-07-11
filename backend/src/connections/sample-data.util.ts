import { randomUUID } from 'crypto';
import type { ColumnMeta } from '../drivers/driver.interface';

/**
 * Self-contained fake-data generators for the "Generate sample data" feature.
 *
 * No external `faker` dependency — these are small, deterministic-ish pure
 * helpers that produce type-appropriate values from a column's metadata. The
 * column NAME is used as a hint (e.g. `email` -> an email address) so generated
 * rows read realistically.
 */

const FIRST_NAMES = [
  'Alex', 'Sam', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie',
  'Avery', 'Quinn', 'Noah', 'Emma', 'Liam', 'Olivia', 'Ava', 'Sophia',
  'Mason', 'Isabella', 'Lucas', 'Mia', 'Ethan', 'Amelia', 'Leo', 'Layla',
];
const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller',
  'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez',
  'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Lee',
];
const CITIES = [
  'London', 'Paris', 'Berlin', 'Madrid', 'Rome', 'Tokyo', 'Toronto',
  'Sydney', 'Dubai', 'Amsterdam', 'Vienna', 'Oslo', 'Lisbon', 'Prague',
];
const COUNTRIES = [
  'United Kingdom', 'France', 'Germany', 'Spain', 'Italy', 'Japan', 'Canada',
  'Australia', 'Brazil', 'India', 'Norway', 'Portugal', 'Netherlands',
];
const STREETS = ['Main St', 'High St', 'Park Ave', 'Oak Rd', 'Maple Dr', 'Elm St', 'Cedar Ln'];
const STATUSES = ['active', 'inactive', 'pending', 'archived', 'draft'];
const LOREM = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing',
  'elit', 'sed', 'eiusmod', 'tempor', 'incididunt', 'labore', 'magna',
  'aliqua', 'enim', 'minim', 'veniam', 'quis', 'nostrud', 'aliquip',
];
const DOMAINS = ['example.com', 'test.io', 'mail.com', 'demo.org', 'sample.net'];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function words(n: number): string {
  return Array.from({ length: n }, () => pick(LOREM)).join(' ');
}
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
}

function personName(): string {
  return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
}
function email(): string {
  return `${slug(pick(FIRST_NAMES))}.${slug(pick(LAST_NAMES))}${randInt(1, 999)}@${pick(DOMAINS)}`;
}
function phone(): string {
  return `+1${randInt(200, 999)}${randInt(200, 999)}${String(randInt(0, 9999)).padStart(4, '0')}`;
}
function url(): string {
  return `https://www.${slug(pick(LAST_NAMES))}.${pick(['com', 'io', 'org', 'net'])}/${pick(LOREM)}`;
}
function address(): string {
  return `${randInt(1, 9999)} ${pick(STREETS)}`;
}
function alnumCode(len = 8): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/** A random datetime within the last ~2 years. */
function recentDate(): Date {
  const now = Date.now();
  const twoYears = 2 * 365 * 24 * 60 * 60 * 1000;
  return new Date(now - Math.floor(Math.random() * twoYears));
}

/** Normalise a Postgres/MySQL data-type string to a coarse family. */
type TypeFamily =
  | 'boolean' | 'integer' | 'decimal' | 'uuid' | 'json'
  | 'timestamp' | 'date' | 'time' | 'text' | 'enum' | 'unknown';

export function classifyType(dataType: string): TypeFamily {
  const t = (dataType || '').toLowerCase().trim();
  if (t === 'user-defined' || t === 'enum') return 'enum';
  if (t === 'boolean' || t === 'bool' || t === 'bit') return 'boolean';
  if (t === 'uuid' || t === 'uniqueidentifier') return 'uuid';
  if (t === 'json' || t === 'jsonb') return 'json';
  if (
    /^(smallint|integer|int|int2|int4|int8|bigint|serial|bigserial|smallserial|tinyint|mediumint|year)/.test(t)
  ) return 'integer';
  if (
    /^(numeric|decimal|real|double|float|money|smallmoney|number|dec)/.test(t)
  ) return 'decimal';
  if (/^(timestamp|datetime|datetimeoffset|smalldatetime)/.test(t)) return 'timestamp';
  if (t === 'date') return 'date';
  if (/^time/.test(t)) return 'time';
  if (
    /(char|text|string|clob|nchar|nvarchar|varchar|character|citext|name|xml|inet|cidr|macaddr)/.test(t)
  ) return 'text';
  return 'unknown';
}

/** Generate a realistic string using the column name as a hint. */
function textForColumn(name: string, maxLen: number | null | undefined): string {
  const n = (name || '').toLowerCase();
  let v: string;
  if (/(^|_)(email|e_mail)($|_)/.test(n) || n === 'email') v = email();
  else if (/(full_?name|display_?name|contact_?name|customer_?name|user_?name|username|first_?name|last_?name|name)$/.test(n) || n === 'name') {
    if (/first_?name/.test(n)) v = pick(FIRST_NAMES);
    else if (/last_?name|surname/.test(n)) v = pick(LAST_NAMES);
    else if (/user_?name|username/.test(n)) v = `${slug(pick(FIRST_NAMES))}${randInt(1, 999)}`;
    else v = personName();
  }
  else if (/(phone|mobile|tel|fax)/.test(n)) v = phone();
  else if (/(url|link|website|homepage|href)/.test(n)) v = url();
  else if (/(city|town)/.test(n)) v = pick(CITIES);
  else if (/(country|nation)/.test(n)) v = pick(COUNTRIES);
  else if (/(address|street|addr)/.test(n)) v = address();
  else if (/(state|province|region)/.test(n)) v = pick(CITIES);
  else if (/(zip|postal|postcode)/.test(n)) v = String(randInt(10000, 99999));
  else if (/(status|state)$/.test(n)) v = pick(STATUSES);
  else if (/(description|summary|bio|about|note|comment|message|body|content)/.test(n)) v = capitalize(words(randInt(6, 14))) + '.';
  else if (/(title|subject|label|heading)/.test(n)) v = capitalize(words(randInt(2, 4)));
  else if (/(sku|code|slug|token|ref|reference)/.test(n)) v = alnumCode(randInt(6, 10));
  else if (/(color|colour)/.test(n)) v = pick(['red', 'green', 'blue', 'black', 'white', 'orange']);
  else if (/(currency)/.test(n)) v = pick(['USD', 'EUR', 'GBP', 'JPY', 'CAD']);
  else if (/(company|organization|organisation|business)/.test(n)) v = `${pick(LAST_NAMES)} ${pick(['Ltd', 'Inc', 'LLC', 'Group', 'Co'])}`;
  else if (/(password|hash|secret)/.test(n)) v = alnumCode(24);
  else v = capitalize(words(randInt(2, 5)));

  if (typeof maxLen === 'number' && maxLen > 0 && v.length > maxLen) {
    v = v.slice(0, maxLen);
  }
  return v;
}

function integerForColumn(name: string, precision: number | null | undefined): number {
  const n = (name || '').toLowerCase();
  if (/(age)/.test(n)) return randInt(18, 90);
  if (/(year)/.test(n)) return randInt(1990, 2025);
  if (/(quantity|qty|count|stock|amount|number|num)/.test(n)) return randInt(0, 1000);
  if (/(price|cost|total|balance)/.test(n)) return randInt(1, 10000);
  if (/(_id|^id|fk)/.test(n)) return randInt(1, 100000);
  // Keep within a tiny precision if the column can only hold a few digits.
  if (typeof precision === 'number' && precision > 0 && precision <= 4) {
    const max = Math.pow(10, precision) - 1;
    return randInt(0, max);
  }
  return randInt(0, 100000);
}

function decimalForColumn(name: string, scale: number | null | undefined): number {
  const s = typeof scale === 'number' && scale >= 0 ? Math.min(scale, 6) : 2;
  const n = (name || '').toLowerCase();
  const whole = /(price|cost|total|amount|balance|salary|revenue)/.test(n)
    ? randInt(1, 9999)
    : randInt(0, 1000);
  const frac = s > 0 ? Math.random() : 0;
  return Number((whole + frac).toFixed(s));
}

/**
 * Produce a value for a single column. Returns the special sentinel `SKIP`
 * to mean "omit this column from the INSERT" (caller filters these out).
 */
export const SKIP = Symbol('skip-column');

export interface GenerateContext {
  /** Enum labels resolved from the DB, keyed by column name (lowercased). */
  enumLabels?: Map<string, string[]>;
  /** Probability (0..1) that a nullable column is set NULL for realism. */
  nullChance?: number;
}

export function valueForColumn(col: ColumnMeta, ctx: GenerateContext = {}): unknown | typeof SKIP {
  const nullChance = ctx.nullChance ?? 0.15;
  // Occasionally NULL a nullable column for realism.
  if (col.nullable && Math.random() < nullChance) return null;

  const family = classifyType(col.dataType);

  switch (family) {
    case 'boolean':
      return Math.random() < 0.5;
    case 'integer':
      return integerForColumn(col.name, col.numericPrecision);
    case 'decimal':
      return decimalForColumn(col.name, col.numericScale);
    case 'uuid':
      // A non-PK uuid is almost always a foreign key. Generating a random one
      // would violate the FK constraint, so prefer NULL when the column allows
      // it. If NOT NULL, generate a uuid and let the DB reject it if an FK
      // exists (the error is surfaced to the caller).
      if (col.nullable) return null;
      return randomUUID();
    case 'json':
      return JSON.stringify({ key: pick(LOREM), n: randInt(1, 1000) });
    case 'timestamp':
      return recentDate().toISOString();
    case 'date':
      return recentDate().toISOString().slice(0, 10);
    case 'time':
      return recentDate().toISOString().slice(11, 19);
    case 'enum': {
      const labels = ctx.enumLabels?.get(col.name.toLowerCase());
      if (labels && labels.length) return pick(labels);
      // Unknown user-defined type: skip if we can (nullable), else best-effort.
      if (col.nullable) return SKIP;
      return pick(STATUSES);
    }
    case 'text':
      return textForColumn(col.name, col.charMaxLength);
    default:
      // Unknown type. Skip nullable ones (let default/NULL apply); otherwise a
      // short string is the safest best-effort.
      if (col.nullable) return SKIP;
      return textForColumn(col.name, col.charMaxLength);
  }
}

/**
 * Decide whether a column should be filled at all. We SKIP columns the database
 * fills for us so we never fight identity/serial sequences or default-generated
 * primary keys:
 *   - identity columns (GENERATED ... AS IDENTITY)
 *   - serial / auto-increment (default references a sequence via `nextval`)
 *   - a primary key that has ANY default (e.g. `gen_random_uuid()`, `uuid_generate_v4()`,
 *     an identity, or a sequence) — let the DB generate it.
 */
export function shouldSkipColumn(col: ColumnMeta): boolean {
  if (col.isIdentity) return true;
  const def = (col.defaultValue || '').toLowerCase();
  if (def.includes('nextval')) return true; // serial / auto sequence
  if (col.isPrimaryKey && def.length > 0) return true; // PK the DB auto-fills
  return false;
}

/**
 * Build `count` fake row objects for the given columns. Columns the DB should
 * fill are omitted entirely so the INSERT relies on their defaults/identity.
 */
export function buildRows(
  columns: ColumnMeta[],
  count: number,
  ctx: GenerateContext = {},
): Record<string, unknown>[] {
  const usable = columns.filter((c) => !shouldSkipColumn(c));
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    const row: Record<string, unknown> = {};
    for (const col of usable) {
      const v = valueForColumn(col, ctx);
      if (v === SKIP) continue;
      row[col.name] = v;
    }
    rows.push(row);
  }
  return rows;
}
