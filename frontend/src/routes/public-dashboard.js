import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Loader2, RefreshCw } from "lucide-react";
import { api, extractErrorMessage, } from "@/lib/api";
import { QueryChart } from "@/components/query-chart";
export default function PublicDashboardRoute() {
    const { token } = useParams();
    const q = useQuery({
        queryKey: ["public-dashboard", token],
        queryFn: () => api.getPublicDashboard(token),
        enabled: !!token,
    });
    if (q.isLoading) {
        return (_jsx("div", { className: "min-h-screen flex items-center justify-center text-muted-foreground", children: _jsx(Loader2, { className: "h-5 w-5 animate-spin" }) }));
    }
    if (q.error || !q.data) {
        return (_jsx("div", { className: "min-h-screen flex items-center justify-center text-destructive", children: "Dashboard not found or sharing was revoked." }));
    }
    const d = q.data;
    return (_jsxs("div", { className: "min-h-screen bg-background", children: [_jsxs("header", { className: "h-14 flex items-center px-6 border-b border-border bg-card/50", children: [_jsx(BarChart3, { className: "h-5 w-5 text-primary mr-2" }), _jsxs("div", { className: "min-w-0", children: [_jsx("div", { className: "font-semibold truncate", children: d.name }), d.description && (_jsx("div", { className: "text-[11px] text-muted-foreground truncate", children: d.description }))] }), _jsx("div", { className: "ml-auto text-[11px] text-muted-foreground", children: "Public view \u00B7 read-only" })] }), _jsx("div", { className: "p-6", children: _jsx("div", { className: "grid gap-3", style: { gridTemplateColumns: "repeat(12, minmax(0, 1fr))" }, children: d.tiles.map((t) => (_jsx(PublicTileCard, { token: token, tile: t, refreshSec: d.refreshSec ?? null }, t.id))) }) })] }));
}
function PublicTileCard({ token, tile, refreshSec, }) {
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);
    const runRef = useRef(() => Promise.resolve());
    runRef.current = async () => {
        setLoading(true);
        setError(null);
        try {
            const r = await api.runPublicDashboardTile(token, tile.id);
            setResult(r);
        }
        catch (err) {
            setError(extractErrorMessage(err));
        }
        finally {
            setLoading(false);
        }
    };
    useEffect(() => {
        void runRef.current();
        if (!refreshSec)
            return;
        const iv = setInterval(() => void runRef.current(), refreshSec * 1000);
        return () => clearInterval(iv);
    }, [refreshSec, tile.id]);
    const chart = tile.chartConfig;
    return (_jsxs("div", { className: "rounded-md border border-border bg-card overflow-hidden flex flex-col", style: { gridColumn: `span ${tile.w} / span ${tile.w}`, minHeight: tile.h * 60 + 60 }, children: [_jsxs("div", { className: "flex items-center justify-between px-3 py-2 border-b border-border", children: [_jsx("div", { className: "text-sm font-medium truncate", children: tile.title }), _jsx("button", { type: "button", className: "text-muted-foreground hover:text-foreground p-1", onClick: () => void runRef.current(), disabled: loading, children: _jsx(RefreshCw, { className: "h-3.5 w-3.5 " + (loading ? "animate-spin" : "") }) })] }), _jsxs("div", { className: "flex-1 min-h-0 p-2", children: [error && _jsx("div", { className: "p-3 text-xs text-destructive", children: error }), !error && !result && loading && (_jsx("div", { className: "h-full flex items-center justify-center text-muted-foreground", children: _jsx(Loader2, { className: "h-4 w-4 animate-spin" }) })), !error && result && chart && _jsx(QueryChart, { config: chart, rows: result.rows, height: tile.h * 60 }), !error && result && !chart && (_jsx("div", { className: "p-3 text-xs text-muted-foreground", children: "No chart configured for this tile." }))] })] }));
}
