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
          <Toaster richColors closeButton />
        </ModalProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
