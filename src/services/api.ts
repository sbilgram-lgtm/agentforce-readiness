import axios from 'axios';

const api = axios.create({ withCredentials: true });

export async function logout() {
  const { data } = await api.post('/auth/logout');
  return data;
}

export async function getAuthStatus(): Promise<{ loggedIn: boolean; instanceUrl: string | null }> {
  const { data } = await api.get('/auth/status');
  return data;
}

export async function fetchCategory(categoryId: string) {
  const { data } = await api.get(`/api/assess/${categoryId}`);
  return data;
}

export async function getAgentDesignData() {
  const res = await fetch('/api/assess/agent-design', { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to fetch agent design data');
  return res.json();
}

export async function getPromptEngineeringData() {
  const res = await fetch('/api/assess/prompt-engineering', { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to fetch prompt engineering data');
  return res.json();
}

export async function getEscalationData() {
  const res = await fetch('/api/assess/escalation', { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to fetch escalation data');
  return res.json();
}

export async function getMiddlewareData() {
  const res = await fetch('/api/assess/middleware', { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to fetch middleware data');
  return res.json();
}
