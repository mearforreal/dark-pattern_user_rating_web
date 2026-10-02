async function request(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  startSession: (name, email, passcode) =>
    request("POST", "/api/sessions", { name, email, passcode }),
  getSession: (id) => request("GET", `/api/sessions/${id}`),
  select: (id, body) => request("POST", `/api/sessions/${id}/selections`, body),
  feedback: (id, reason) => request("POST", `/api/sessions/${id}/feedback`, { reason }),
  complete: (id) => request("POST", `/api/sessions/${id}/complete`),
};

export function adminApi(password) {
  const h = { "x-admin-password": password };
  return {
    stats: () => request("GET", "/api/admin/stats", null, h),
    sessions: () => request("GET", "/api/admin/sessions", null, h),
    session: (id) => request("GET", `/api/admin/sessions/${id}`, null, h),
    deleteSession: (id) => request("DELETE", `/api/admin/sessions/${id}`, null, h),
    exportCsv: async () => {
      const res = await fetch("/api/admin/export.csv", { headers: h });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      return res.blob();
    },
  };
}
