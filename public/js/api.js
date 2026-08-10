'use strict';
/** שכבת התקשורת מול השרת. */

const API = (() => {
  async function call(method, url, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    }
    if (!res.ok) {
      const err = new Error(data?.error ?? `שגיאה ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const qs = (params) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined && v !== null && v !== '') p.set(k, v);
    }
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  return {
    get: (url) => call('GET', url),
    post: (url, body) => call('POST', url, body ?? {}),
    patch: (url, body) => call('PATCH', url, body ?? {}),
    put: (url, body) => call('PUT', url, body ?? {}),
    del: (url) => call('DELETE', url),

    login: (email, password) => call('POST', '/api/auth/login', { email, password }),
    logout: () => call('POST', '/api/auth/logout', {}),
    bootstrap: () => call('GET', '/api/bootstrap'),

    home: () => call('GET', '/api/home'),
    tasks: (filters) => call('GET', `/api/tasks${qs(filters)}`),
    task: (id) => call('GET', `/api/tasks/${id}`),
    createTask: (body) => call('POST', '/api/tasks', body),
    updateTask: (id, body) => call('PATCH', `/api/tasks/${id}`, body),
    deleteTask: (id) => call('DELETE', `/api/tasks/${id}`),
    bulk: (ids, action, value) => call('POST', '/api/tasks/bulk', { ids, action, value }),
    review: (id, decision, note) => call('POST', `/api/tasks/${id}/review`, { decision, note }),

    addChecklist: (id, text) => call('POST', `/api/tasks/${id}/checklist`, { text }),
    toggleChecklist: (id, done) => call('PATCH', `/api/checklist/${id}`, { done }),
    deleteChecklist: (id) => call('DELETE', `/api/checklist/${id}`),

    addComment: (id, body, internal) => call('POST', `/api/tasks/${id}/comments`, { body, internal }),
    upload: (id, filename, mime, data) => call('POST', `/api/tasks/${id}/attachments`, { filename, mime, data }),

    notifications: () => call('GET', '/api/notifications'),
    markRead: (id) => call('POST', '/api/notifications/read', id ? { id } : {}),

    projects: () => call('GET', '/api/projects'),
    createProject: (body) => call('POST', '/api/projects', body),
    updateProject: (id, body) => call('PATCH', `/api/projects/${id}`, body),
    deleteProject: (id) => call('DELETE', `/api/projects/${id}`),

    reports: () => call('GET', '/api/reports'),
    search: (q) => call('GET', `/api/search?q=${encodeURIComponent(q)}`),

    adminUsers: () => call('GET', '/api/admin/users'),
    createUser: (body) => call('POST', '/api/admin/users', body),
    resendInvite: (targetType, id) => call('POST', '/api/admin/invite', { targetType, id }),
    updateUser: (id, body) => call('PATCH', `/api/admin/users/${id}`, body),

    createVendor: (body) => call('POST', '/api/vendors', body),
    updateVendor: (id, body) => call('PATCH', `/api/vendors/${id}`, body),

    settings: () => call('GET', '/api/admin/settings'),
    saveSettings: (settings) => call('PUT', '/api/admin/settings', { settings }),
    createRule: (body) => call('POST', '/api/admin/rules', body),
    updateRule: (id, body) => call('PATCH', `/api/admin/rules/${id}`, body),
    deleteRule: (id) => call('DELETE', `/api/admin/rules/${id}`),
    runRules: () => call('POST', '/api/admin/rules/run', {}),
    wipeSystem: (confirm) => call('POST', '/api/admin/wipe', { confirm }),
    addColumn: (boardId, body) => call('POST', `/api/boards/${boardId}/columns`, body),

    saveFilter: (name, payload) => call('POST', '/api/saved-filters', { name, payload }),
    deleteFilter: (id) => call('DELETE', `/api/saved-filters/${id}`),
    templates: () => call('GET', '/api/templates'),
    createTemplate: (body) => call('POST', '/api/templates', body),
    deleteTemplate: (id) => call('DELETE', `/api/templates/${id}`)
  };
})();
