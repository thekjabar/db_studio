import { create } from "zustand";

export type Density = "SMALL" | "MEDIUM" | "LARGE";
export type ServerTheme = "LIGHT" | "DARK" | "SYSTEM";

export interface AuthUser {
  id: string;
  email: string;
  displayName?: string;
  density?: Density;
  theme?: ServerTheme;
  totpEnabled?: boolean;
  isAdmin?: boolean;
}

interface AuthState {
  accessToken: string | null;
  user: AuthUser | null;
  /** True until the initial silent-refresh attempt finishes. Public pages
   *  render regardless; only Protected routes wait on this so a logged-in
   *  user with just a refresh cookie isn't bounced to /login prematurely. */
  bootstrapping: boolean;
  setBootstrapping: (v: boolean) => void;
  setAuth: (accessToken: string, user: AuthUser) => void;
  setAccessToken: (token: string | null) => void;
  setUser: (user: AuthUser | null) => void;
  clear: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  accessToken: null,
  user: null,
  bootstrapping: true,
  setBootstrapping: (v) => set({ bootstrapping: v }),
  setAuth: (accessToken, user) => set({ accessToken, user }),
  setAccessToken: (accessToken) => set({ accessToken }),
  setUser: (user) => set({ user }),
  clear: () => set({ accessToken: null, user: null }),
}));
