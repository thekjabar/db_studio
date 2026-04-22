import { Toaster } from "sonner";
import { useTheme } from "@/lib/theme-store";

export function ThemedToaster() {
  const theme = useTheme((s) => s.theme);
  return <Toaster theme={theme} position="bottom-right" richColors />;
}
