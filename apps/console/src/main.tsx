import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
// 공용 스타일을 먼저 — 페이지 CSS(pages/*.css)가 같은 우선순위에서 덮어쓸 수 있게
import './console.css';
import { AuthProvider } from './auth';
import { AppRoutes } from './routes';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename="/console">
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
