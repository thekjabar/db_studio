import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis, } from "recharts";
const PALETTE = [
    "hsl(152 61% 42%)",
    "hsl(220 80% 55%)",
    "hsl(280 60% 55%)",
    "hsl(38 90% 55%)",
    "hsl(340 70% 55%)",
    "hsl(180 70% 40%)",
    "hsl(20 80% 55%)",
    "hsl(260 65% 60%)",
];
function toNumber(v) {
    if (v === null || v === undefined)
        return 0;
    if (typeof v === "number")
        return v;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}
export function QueryChart({ config, rows, height = 280 }) {
    if (!rows.length) {
        return (_jsx("div", { className: "text-xs text-muted-foreground p-6 text-center", children: "No rows to chart." }));
    }
    // Cap rows to avoid mega-charts that block the browser.
    const data = rows.slice(0, config.limit ?? 500).map((r) => {
        const row = { [config.x]: r[config.x] };
        for (const y of config.y)
            row[y] = toNumber(r[y]);
        return row;
    });
    const common = (_jsxs(_Fragment, { children: [_jsx(CartesianGrid, { stroke: "hsl(var(--border))", strokeDasharray: "3 3" }), _jsx(XAxis, { dataKey: config.x, tick: { fontSize: 11 }, stroke: "hsl(var(--muted-foreground))" }), _jsx(YAxis, { tick: { fontSize: 11 }, stroke: "hsl(var(--muted-foreground))" }), _jsx(Tooltip, { contentStyle: {
                    background: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 6,
                    fontSize: 12,
                } }), _jsx(Legend, { wrapperStyle: { fontSize: 11 } })] }));
    return (_jsx("div", { className: "w-full", style: { height }, children: _jsx(ResponsiveContainer, { width: "100%", height: "100%", children: (() => {
                switch (config.type) {
                    case "line":
                        return (_jsxs(LineChart, { data: data, margin: { top: 8, right: 16, bottom: 8, left: 0 }, children: [common, config.y.map((y, i) => (_jsx(Line, { type: "monotone", dataKey: y, stroke: PALETTE[i % PALETTE.length], strokeWidth: 2, dot: false }, y)))] }));
                    case "area":
                        return (_jsxs(AreaChart, { data: data, margin: { top: 8, right: 16, bottom: 8, left: 0 }, children: [common, config.y.map((y, i) => (_jsx(Area, { type: "monotone", dataKey: y, stackId: config.stacked ? "s" : undefined, fill: PALETTE[i % PALETTE.length], stroke: PALETTE[i % PALETTE.length], fillOpacity: 0.3 }, y)))] }));
                    case "bar":
                        return (_jsxs(BarChart, { data: data, margin: { top: 8, right: 16, bottom: 8, left: 0 }, children: [common, config.y.map((y, i) => (_jsx(Bar, { dataKey: y, stackId: config.stacked ? "s" : undefined, fill: PALETTE[i % PALETTE.length] }, y)))] }));
                    case "pie": {
                        const y = config.y[0];
                        if (!y) {
                            return (_jsx("div", { className: "text-xs text-muted-foreground p-6 text-center", children: "Pie chart needs a single Y column." }));
                        }
                        return (_jsxs(PieChart, { children: [_jsx(Tooltip, { contentStyle: {
                                        background: "hsl(var(--card))",
                                        border: "1px solid hsl(var(--border))",
                                        borderRadius: 6,
                                        fontSize: 12,
                                    } }), _jsx(Legend, { wrapperStyle: { fontSize: 11 } }), _jsx(Pie, { data: data, dataKey: y, nameKey: config.x, outerRadius: 100, children: data.map((_, i) => (_jsx(Cell, { fill: PALETTE[i % PALETTE.length] }, i))) })] }));
                    }
                }
            })() }) }));
}
