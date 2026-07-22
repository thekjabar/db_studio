import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemedToaster } from "./components/themed-toaster";
import App from "./App";
import "./styles/globals.css";
import "@xyflow/react/dist/style.css";
import { applyDensity, getCachedDensity } from "./lib/density";
import { ModalProvider } from "./components/modal-provider";
import { BackupJobProvider } from "./components/backup-job-provider";
import { BackupToast } from "./components/backup-toast";
import { GlobalCommandPalette } from "./components/global-command-palette";
import { ErrorBoundary } from "./components/error-boundary";

// Apply the cached density before React renders — avoids a flash.
applyDensity(getCachedDensity());

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 30_000 } },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter basename="/v2">
          <ModalProvider>
            <BackupJobProvider>
              <App />
              <GlobalCommandPalette />
              <BackupToast />
              <ThemedToaster />
            </BackupJobProvider>
          </ModalProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
