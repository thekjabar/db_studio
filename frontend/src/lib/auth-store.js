import { create } from "zustand";
export const useAuth = create((set) => ({
    accessToken: null,
    user: null,
    setAuth: (accessToken, user) => set({ accessToken, user }),
    setAccessToken: (accessToken) => set({ accessToken }),
    setUser: (user) => set({ user }),
    clear: () => set({ accessToken: null, user: null }),
}));
