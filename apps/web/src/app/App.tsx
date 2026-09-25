import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProviders } from './providers';
import { RouteView } from './routes';
import '../styles/tokens.css';

export function App() {
  return <AppProviders><RouteView /></AppProviders>;
}

const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(<StrictMode><App /></StrictMode>);
