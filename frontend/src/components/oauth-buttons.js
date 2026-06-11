import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useQuery } from "@tanstack/react-query";
import { Github } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
function GoogleIcon({ className }) {
    return (_jsxs("svg", { viewBox: "0 0 24 24", className: className, "aria-hidden": true, children: [_jsx("path", { fill: "#4285F4", d: "M23.64 12.204c0-.815-.073-1.6-.209-2.352H12v4.449h6.527a5.583 5.583 0 0 1-2.422 3.664v3.041h3.918c2.293-2.113 3.617-5.222 3.617-8.802Z" }), _jsx("path", { fill: "#34A853", d: "M12 24c3.267 0 6.006-1.082 8.008-2.94l-3.918-3.041c-1.085.726-2.472 1.157-4.09 1.157-3.147 0-5.81-2.124-6.76-4.977H1.184v3.128A12 12 0 0 0 12 24Z" }), _jsx("path", { fill: "#FBBC05", d: "M5.24 14.199a7.216 7.216 0 0 1 0-4.598V6.473H1.184a12.014 12.014 0 0 0 0 11.054l4.056-3.128Z" }), _jsx("path", { fill: "#EA4335", d: "M12 4.755c1.776 0 3.372.612 4.627 1.811l3.473-3.473C18.005 1.185 15.266 0 12 0 7.312 0 3.282 2.69 1.184 6.473L5.24 9.6C6.19 6.749 8.853 4.755 12 4.755Z" })] }));
}
export function OAuthButtons() {
    const { data } = useQuery({
        queryKey: ["oauth-providers"],
        queryFn: api.oauthProviders,
        staleTime: 5 * 60_000,
    });
    if (!data || (!data.google && !data.github))
        return null;
    return (_jsxs("div", { className: "space-y-2", children: [_jsxs("div", { className: "relative my-4", children: [_jsx("div", { className: "absolute inset-0 flex items-center", children: _jsx("span", { className: "w-full border-t border-border" }) }), _jsx("div", { className: "relative flex justify-center text-xs uppercase", children: _jsx("span", { className: "bg-card px-2 text-muted-foreground", children: "or" }) })] }), data.google && (_jsxs(Button, { type: "button", variant: "outline", className: "w-full", onClick: () => {
                    window.location.href = api.oauthUrl("google");
                }, children: [_jsx(GoogleIcon, { className: "h-4 w-4 mr-2" }), "Continue with Google"] })), data.github && (_jsxs(Button, { type: "button", variant: "outline", className: "w-full", onClick: () => {
                    window.location.href = api.oauthUrl("github");
                }, children: [_jsx(Github, { className: "h-4 w-4 mr-2" }), "Continue with GitHub"] }))] }));
}
