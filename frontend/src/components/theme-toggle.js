import { jsx as _jsx } from "react/jsx-runtime";
import { Moon, Sun } from "lucide-react";
import { Button } from "./ui/button";
import { useTheme } from "@/lib/theme-store";
export function ThemeToggle() {
    const { theme, toggle } = useTheme();
    return (_jsx(Button, { variant: "ghost", size: "icon", onClick: toggle, title: "Toggle theme", children: theme === "dark" ? _jsx(Sun, { className: "h-4 w-4" }) : _jsx(Moon, { className: "h-4 w-4" }) }));
}
