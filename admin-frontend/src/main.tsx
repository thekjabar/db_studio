import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { ModalProvider } from './components/modal-provider';
import './styles.css';
import App from './App';

const qc = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <ModalProvider>
          <App />
          <Toaster
            theme="dark"
            richColors
            closeButton
            position="bottom-right"
            toastOptions={{
              // Pin toasts to the app's dark card palette so they never
              // flash white on reload regardless of system preference.
              style: {
                background: 'hsl(var(--card))',
                color: 'hsl(var(--foreground))',
                border: '1px solid hsl(var(--border))',
              },
            }}
          />
        </ModalProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
