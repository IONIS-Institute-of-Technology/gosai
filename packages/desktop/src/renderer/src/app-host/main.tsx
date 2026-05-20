import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppHost } from './AppHost.js';
import '../styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root container missing');

createRoot(container).render(
  <StrictMode>
    <AppHost />
  </StrictMode>,
);
