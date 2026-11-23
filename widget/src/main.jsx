import { Component, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { announce, reportSize, detectTheme } from './host';
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

document.documentElement.dataset.theme = detectTheme();
// Inside CNCjs the iframe is sized to its content, so it never needs a scroll bar of its own.
if (window.parent !== window) document.documentElement.classList.add('embedded');
reportSize();
announce();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary><App /></ErrorBoundary>
  </StrictMode>
);
