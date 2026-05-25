import React, { useState, useEffect } from 'react';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import { getAuthStatus } from './services/api';

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [instanceUrl, setInstanceUrl] = useState('');
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    getAuthStatus()
      .then(s => { setLoggedIn(s.loggedIn); setInstanceUrl(s.instanceUrl || ''); })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  if (checking) return <div style={{ padding: 40, textAlign: 'center' }}>Loading…</div>;

  return loggedIn
    ? <DashboardPage instanceUrl={instanceUrl} onLogout={() => setLoggedIn(false)} />
    : <LoginPage onLogin={() => {}} />;
}
