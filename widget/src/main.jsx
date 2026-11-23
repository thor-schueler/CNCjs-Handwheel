import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { announce, reportSize, detectTheme } from './host';
import './styles.css';

document.documentElement.dataset.theme = detectTheme();
reportSize();
announce();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
