import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ChartConfig } from "@/lib/api";

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

interface Props {
  config: ChartConfig;
  rows: Record<string, unknown>[];
  height?: number;
}

function toNumber(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function QueryChart({ config, rows, height = 280 }: Props) {
  if (!rows.length) {
    return (
      <div className="text-xs text-muted-foreground p-6 text-center">
        No rows to chart.
      </div>
    );
  }
  // Cap rows to avoid mega-charts that block the browser.
  const data = rows.slice(0, config.limit ?? 500).map((r) => {
    const row: Record<string, unknown> = { [config.x]: r[config.x] };
    for (const y of config.y) row[y] = toNumber(r[y]);
    return row;
  });

  const common = (
    <>
      <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
      <XAxis dataKey={config.x} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
      <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
      <Tooltip
        contentStyle={{
          background: "hsl(var(--card))",
          border: "1px solid hsl(var(--border))",
          borderRadius: 6,
          fontSize: 12,
        }}
      />
      <Legend wrapperStyle={{ fontSize: 11 }} />
    </>
  );

  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {(() => {
          switch (config.type) {
            case "line":
              return (
                <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                  {common}
                  {config.y.map((y, i) => (
                    <Line key={y} type="monotone" dataKey={y} stroke={PALETTE[i % PALETTE.length]} strokeWidth={2} dot={false} />
                  ))}
                </LineChart>
              );
            case "area":
              return (
                <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                  {common}
                  {config.y.map((y, i) => (
                    <Area
                      key={y}
                      type="monotone"
                      dataKey={y}
                      stackId={config.stacked ? "s" : undefined}
                      fill={PALETTE[i % PALETTE.length]}
                      stroke={PALETTE[i % PALETTE.length]}
                      fillOpacity={0.3}
                    />
                  ))}
                </AreaChart>
              );
            case "bar":
              return (
                <BarChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                  {common}
                  {config.y.map((y, i) => (
                    <Bar
                      key={y}
                      dataKey={y}
                      stackId={config.stacked ? "s" : undefined}
                      fill={PALETTE[i % PALETTE.length]}
                    />
                  ))}
                </BarChart>
              );
            case "pie": {
              const y = config.y[0];
              if (!y) {
                return (
                  <div className="text-xs text-muted-foreground p-6 text-center">
                    Pie chart needs a single Y column.
                  </div>
                );
              }
              return (
                <PieChart>
                  <Tooltip
                    contentStyle={{
                      background: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Pie data={data} dataKey={y} nameKey={config.x} outerRadius={100}>
                    {data.map((_, i) => (
                      <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                    ))}
                  </Pie>
                </PieChart>
              );
            }
          }
        })()}
      </ResponsiveContainer>
    </div>
  );
}
