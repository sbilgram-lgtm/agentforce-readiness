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
