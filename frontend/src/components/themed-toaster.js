import { jsx as _jsx } from "react/jsx-runtime";
import { Toaster } from "sonner";
import { useTheme } from "@/lib/theme-store";
export function ThemedToaster() {
    const theme = useTheme((s) => s.theme);
    return _jsx(Toaster, { theme: theme, position: "bottom-right", richColors: true });
}
