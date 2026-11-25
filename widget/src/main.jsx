import { Component, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { connectToHost, followHostColorMode, forcedTheme, reportSize } from './host';
import adoptHostTheme from './hostTheme';
import './styles.css';

/** Shows a render error in the widget instead of leaving a blank iframe. */
class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    return error
      ? <p className="hint" style={{ padding: 10 }}>Widget error: {String(error.message || error)}</p>
      : this.props.children;
  }
}

// Light or dark as CNCjs reports it (any origin); the colours themselves come from CNCjs when it is the same origin.
followHostColorMode();
if (!forcedTheme) adoptHostTheme();
// Inside CNCjs the iframe is sized to its content, so it never needs a scroll bar of its own.
if (window.parent !== window) document.documentElement.classList.add('embedded');
reportSize();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary><App /></ErrorBoundary>
  </StrictMode>
);
// The listener is installed before the question is asked; what the answer holds is kept in a store, so a reply that
// beats the first render is still read when the components mount.
connectToHost();
