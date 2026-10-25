import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import '../styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing console root element');
createRoot(root).render(<App />);

// Development never installs a worker that might serve stale source files.
if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(console.warn);
    });
  } else {
    void navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) void registration.unregister();
    });
  }
}
