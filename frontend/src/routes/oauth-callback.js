import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";
import { applyDensity } from "@/lib/density";
export default function OAuthCallbackPage() {
    const nav = useNavigate();
    const { setAuth } = useAuth();
    const didRun = useRef(false);
    useEffect(() => {
        if (didRun.current)
            return;
        didRun.current = true;
        const parseFragment = (hash) => {
            const h = hash.startsWith("#") ? hash.slice(1) : hash;
            const out = {};
            for (const part of h.split("&")) {
                if (!part)
                    continue;
                const [k, v = ""] = part.split("=");
                out[decodeURIComponent(k)] = decodeURIComponent(v);
            }
            return out;
        };
        const frag = parseFragment(window.location.hash);
        const token = frag.accessToken;
        if (!token) {
            toast.error("Sign-in failed — no token received");
            nav("/login", { replace: true });
            return;
        }
        (async () => {
            useAuth.getState().setAccessToken(token);
            try {
                const user = await api.me();
                setAuth(token, user);
                if (user.density)
                    applyDensity(user.density);
                // Wipe the token from the URL.
                window.history.replaceState(null, "", "/connections");
                toast.success(`Welcome ${user.displayName || user.email}`);
                nav("/connections", { replace: true });
            }
            catch {
                toast.error("Sign-in failed — could not load profile");
                useAuth.getState().clear();
                nav("/login", { replace: true });
            }
        })();
    }, [nav, setAuth]);
    return (_jsxs("div", { className: "min-h-screen flex items-center justify-center text-muted-foreground", children: [_jsx(Loader2, { className: "h-5 w-5 animate-spin mr-2" }), "Signing you in\u2026"] }));
}
