export const config = { runtime: 'edge' };

const GITHUB_API = 'https://api.github.com';

const DEFAULT_ORIGINS = [
  'https://kaoticscout.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

function allowedOrigins() {
  const fromEnv = process.env.ALLOWED_ORIGINS;
  if (!fromEnv) return DEFAULT_ORIGINS;
  return fromEnv.split(',').map(s => s.trim()).filter(Boolean);
}

function corsHeaders(request) {
  const origin = request.headers.get('origin');
  const allowed = allowedOrigins();
  const headers = new Headers({
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Edit-Password',
  });

  if (origin && allowed.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  } else if (!origin && allowed[0]) {
    headers.set('Access-Control-Allow-Origin', allowed[0]);
  }

  return headers;
}

function jsonResponse(request, status, body) {
  const headers = corsHeaders(request);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
}

function decodeBase64Json(b64) {
  const binary = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function encodeBase64Json(value) {
  const str = JSON.stringify(value, null, 2) + '\n';
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach(byte => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function githubConfig() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not configured');
  return {
    token,
    owner: process.env.GITHUB_OWNER || 'kaoticscout',
    repo: process.env.GITHUB_REPO || 'home-calendar',
    path: process.env.DATA_FILE_PATH || 'data.json',
  };
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function readDataset() {
  const { token, owner, repo, path } = githubConfig();
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, {
    headers: githubHeaders(token),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub read failed (${res.status}): ${err}`);
  }

  const file = await res.json();
  const data = decodeBase64Json(file.content);
  if (!Array.isArray(data.tasks)) {
    throw new Error('data.json must contain a "tasks" array');
  }

  return { data, sha: file.sha };
}

async function writeDataset(data, sha, message) {
  const { token, owner, repo, path } = githubConfig();
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: {
      ...githubHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message,
      content: encodeBase64Json(data),
      sha,
    }),
  });

  if (res.status === 409) return { conflict: true };
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub write failed (${res.status}): ${err}`);
  }

  return { conflict: false };
}

async function writeDatasetWithRetry(data, sha, message) {
  const result = await writeDataset(data, sha, message);
  if (!result.conflict) return;

  const fresh = await readDataset();
  const retry = await writeDataset(data, fresh.sha, message);
  if (retry.conflict) {
    throw new Error('Could not save — file changed on GitHub. Please try again.');
  }
}

function isValidTask(task) {
  return (
    task &&
    typeof task.id === 'string' &&
    task.id.length > 0 &&
    typeof task.name === 'string' &&
    task.name.trim().length > 0 &&
    typeof task.category === 'string' &&
    task.schedule &&
    typeof task.schedule.type === 'string'
  );
}

async function addTask(task) {
  if (!isValidTask(task)) throw new Error('Invalid task payload');

  const { data, sha } = await readDataset();
  if (data.tasks.some(t => t.id === task.id)) {
    const err = new Error(`Task id already exists: ${task.id}`);
    err.status = 409;
    throw err;
  }

  data.tasks.push({
    id: task.id,
    name: task.name.trim(),
    category: task.category,
    schedule: task.schedule,
    notes: typeof task.notes === 'string' ? task.notes : '',
  });

  await writeDatasetWithRetry(data, sha, `Add task: ${task.name.trim()}`);
  return data;
}

async function updateTask(taskId, task) {
  if (!isValidTask(task) || task.id !== taskId) {
    throw new Error('Invalid task payload or id mismatch');
  }

  const { data, sha } = await readDataset();
  const idx = data.tasks.findIndex(t => t.id === taskId);
  if (idx === -1) {
    const err = new Error('Task not found');
    err.status = 404;
    throw err;
  }

  data.tasks[idx] = {
    id: taskId,
    name: task.name.trim(),
    category: task.category,
    schedule: task.schedule,
    notes: typeof task.notes === 'string' ? task.notes : (data.tasks[idx].notes ?? ''),
  };

  await writeDatasetWithRetry(data, sha, `Update task: ${task.name.trim()}`);
  return data;
}

async function deleteTask(taskId) {
  const { data, sha } = await readDataset();
  const before = data.tasks.length;
  data.tasks = data.tasks.filter(t => t.id !== taskId);

  if (data.tasks.length === before) {
    const err = new Error('Task not found');
    err.status = 404;
    throw err;
  }

  await writeDatasetWithRetry(data, sha, `Delete task: ${taskId}`);
  return data;
}

function checkEditPassword(request) {
  const required = process.env.EDIT_PASSWORD;
  if (!required) return true;
  return request.headers.get('x-edit-password') === required;
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    const headers = corsHeaders(request);
    return new Response(null, { status: 204, headers });
  }

  const url = new URL(request.url);
  const taskId = url.searchParams.get('id') || '';

  try {
    if (!taskId) {
      if (request.method === 'GET') {
        const { data } = await readDataset();
        return jsonResponse(request, 200, data);
      }

      if (request.method === 'POST') {
        if (!checkEditPassword(request)) {
          return jsonResponse(request, 401, { error: 'Wrong or missing edit password' });
        }
        const task = await request.json();
        const data = await addTask(task);
        return jsonResponse(request, 201, data);
      }

      return jsonResponse(request, 405, { error: 'Method not allowed' });
    }

    if (request.method === 'PUT') {
      if (!checkEditPassword(request)) {
        return jsonResponse(request, 401, { error: 'Wrong or missing edit password' });
      }
      const task = await request.json();
      const data = await updateTask(taskId, task);
      return jsonResponse(request, 200, data);
    }

    if (request.method === 'DELETE') {
      if (!checkEditPassword(request)) {
        return jsonResponse(request, 401, { error: 'Wrong or missing edit password' });
      }
      const data = await deleteTask(taskId);
      return jsonResponse(request, 200, data);
    }

    return jsonResponse(request, 405, { error: 'Method not allowed' });
  } catch (err) {
    return jsonResponse(request, err.status || 500, {
      error: err.message || 'Internal server error',
    });
  }
}
