import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import App from './App';
import './style.css';

const rootElement = document.getElementById('root');
const routerBase = import.meta.env.BASE_URL || '/';

if (!rootElement) {
  throw new Error('Missing #root element for React app bootstrap.');
}

createRoot(rootElement).render(
  <BrowserRouter basename={routerBase}>
    <App />
  </BrowserRouter>
);
