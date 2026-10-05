import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/stack-sans-notch/400.css';
import '@fontsource/inter/400.css';
import '@fontsource/dm-mono/400.css';
import './styles.css';
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
