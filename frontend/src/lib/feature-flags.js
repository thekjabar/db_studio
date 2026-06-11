import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
/**
 * useFeatureFlag("new_editor")
 *
 * One query fetches the whole flags map; every hook call reads from the
 * same cached object so flag lookups are synchronous after first load.
 * Defaults to `false` while loading — treat flags as enhancements, never
 * as gates that block the main UI.
 */
export function useFeatureFlag(key) {
    const q = useQuery({
        queryKey: ["my-flags"],
        queryFn: () => api.myFlags(),
        staleTime: 5 * 60_000,
    });
    return q.data?.[key] ?? false;
}
/** Get the full flag map — useful when a page branches on multiple flags. */
export function useFeatureFlags() {
    const q = useQuery({
        queryKey: ["my-flags"],
        queryFn: () => api.myFlags(),
        staleTime: 5 * 60_000,
    });
    return q.data ?? {};
}
