// Common Postgres column types. Grouped for a usable picker.
// If a user's existing column has a type not in this list (e.g. a domain),
// callers pass it as `defaultValue` and the select will still render it.
export const PG_COLUMN_TYPES = [
    {
        group: "Text",
        items: [
            { value: "text" },
            { value: "character varying", label: "character varying (varchar)" },
            { value: "character", label: "character (char)" },
            { value: "citext" },
        ],
    },
    {
        group: "Numeric",
        items: [
            { value: "smallint", label: "smallint (int2)" },
            { value: "integer", label: "integer (int4)" },
            { value: "bigint", label: "bigint (int8)" },
            { value: "numeric", label: "numeric / decimal" },
            { value: "real", label: "real (float4)" },
            { value: "double precision", label: "double precision (float8)" },
        ],
    },
    {
        group: "Boolean & UUID",
        items: [
            { value: "boolean" },
            { value: "uuid" },
        ],
    },
    {
        group: "Date & Time",
        items: [
            { value: "date" },
            { value: "time" },
            { value: "time with time zone", label: "time with time zone (timetz)" },
            { value: "timestamp", label: "timestamp without time zone" },
            { value: "timestamp with time zone", label: "timestamp with time zone (timestamptz)" },
            { value: "interval" },
        ],
    },
    {
        group: "JSON & Binary",
        items: [
            { value: "json" },
            { value: "jsonb" },
            { value: "bytea" },
        ],
    },
    {
        group: "Network",
        items: [
            { value: "inet" },
            { value: "cidr" },
            { value: "macaddr" },
        ],
    },
];
export function pgTypeOptions(currentValue) {
    const flat = PG_COLUMN_TYPES.flatMap((g) => g.items.map((i) => ({ value: i.value, label: `${g.group} · ${i.label ?? i.value}` })));
    // If the user's existing type isn't in the list, include it so they can keep it.
    if (currentValue && !flat.some((o) => o.value === currentValue)) {
        flat.unshift({ value: currentValue, label: `${currentValue} (current)` });
    }
    return flat;
}
