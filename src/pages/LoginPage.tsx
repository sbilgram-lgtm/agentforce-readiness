import React, { useState, useEffect } from 'react';

interface Props { onLogin: (instanceUrl: string) => void; }

export default function LoginPage({ onLogin }: Props) {
  const [loginUrl, setLoginUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('error') === 'auth_failed') {
      setError('Authentication failed. Check your Client ID, Client Secret, and Callback URL in your Connected App.');
    } else if (params.get('error') === 'missing_credentials') {
      setError('Client ID and Client Secret are required.');
    }
  }, []);

  const handleConnect = async () => {
    if (!loginUrl.trim() || !clientId.trim() || !clientSecret.trim()) {
      setError('All three fields are required.');
      return;
    }
    let url = loginUrl.trim().replace(/\/$/, '');
    if (!url.startsWith('http')) url = 'https://' + url;
    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginUrl: url, clientId: clientId.trim(), clientSecret: clientSecret.trim() }),
        credentials: 'include'
      });
      const data = await res.json();
      if (data.redirectUrl) {
        window.location.href = data.redirectUrl;
      } else {
        setError('Authentication failed. Check your credentials.');
      }
    } catch (e) {
      setError('Could not connect to server.');
    }
  };

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.header}>
          <div style={styles.logo}>⚡</div>
          <h1 style={styles.title}>Agentforce Readiness Assessment</h1>
          <p style={styles.subtitle}>Connect your Salesforce org to begin the assessment</p>
        </div>

        {error && <div style={styles.error}>{error}</div>}

        <div style={styles.form}>
          <label style={styles.label}>
            Org / Sandbox URL
            <input
              style={styles.input}
              type="text"
              placeholder="https://yourorg.sandbox.my.salesforce.com"
              value={loginUrl}
              onChange={e => { setLoginUrl(e.target.value); setError(''); }}
            />
            <span style={styles.hint}>Use your org's My Domain URL</span>
          </label>

          <label style={styles.label}>
            Client ID (Consumer Key)
            <input
              style={styles.input}
              type="text"
              placeholder="3MVG9..."
              value={clientId}
              onChange={e => { setClientId(e.target.value); setError(''); }}
            />
          </label>

          <label style={styles.label}>
            Client Secret (Consumer Secret)
            <input
              style={styles.input}
              type="password"
              placeholder="••••••••••••••••"
              value={clientSecret}
              onChange={e => { setClientSecret(e.target.value); setError(''); }}
            />
          </label>

          <button style={styles.button} onClick={handleConnect}>
            Connect to Salesforce
          </button>
        </div>

        <p style={styles.footer}>
          Requires a Connected App with OAuth enabled.<br />
          Callback URL: <code style={{ fontSize: 11 }}>/auth/callback</code> (relative to your deployed app URL)
        </p>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, #0176d3 0%, #032d60 100%)', padding: 20 },
  card: { background: '#fff', borderRadius: 12, padding: '40px 48px', maxWidth: 480, width: '100%', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' },
  header: { textAlign: 'center', marginBottom: 28 },
  logo: { fontSize: 48, marginBottom: 8 },
  title: { fontSize: 22, fontWeight: 700, color: '#032d60', marginBottom: 8 },
  subtitle: { color: '#5a6472', fontSize: 14 },
  form: { display: 'flex', flexDirection: 'column', gap: 16 },
  label: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, fontWeight: 600, color: '#3e3e3c' },
  input: { padding: '10px 14px', borderRadius: 6, border: '1px solid #c9c9c9', fontSize: 14, outline: 'none', marginTop: 2 },
  hint: { fontSize: 11, color: '#aaa', fontWeight: 400 },
  button: { marginTop: 4, padding: '12px', background: '#0176d3', color: '#fff', border: 'none', borderRadius: 6, fontSize: 15, fontWeight: 600, cursor: 'pointer' },
  error: { background: '#fef0f0', color: '#c23934', borderRadius: 6, padding: '10px 14px', fontSize: 13, marginBottom: 16 },
  footer: { marginTop: 20, fontSize: 12, color: '#888', textAlign: 'center', lineHeight: 1.7 }
};
