import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initialSession } from './client';
import './styles.css';

// Consume the fragment before React renders or starts any API request.
const session = initialSession();
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App initialSession={session} />
  </React.StrictMode>,
);
