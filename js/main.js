async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers });
  const data = await response.json().catch(() => ({}));

  if (response.status === 401) {
    location.href = '/auth/login.html';
    return { error: 'not_authenticated' };
  }
  if (response.status === 403 && data.error === 'access_denied') {
    location.href = '/access.html';
    return { error: 'access_denied' };
  }
  if (!response.ok) return { ...data, error: data.error || `request_failed_${response.status}` };
  return data;
}
