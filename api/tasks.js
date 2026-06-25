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

function setCors(req, res) {
  const headers = req?.headers || {};
  const origin = headers.origin;
  const allowed = allowedOrigins();
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (!origin) {
    res.setHeader('Access-Control-Allow-Origin', allowed[0]);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Edit-Password');
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.trim()) return JSON.parse(req.body);
  return null;
}

function checkEditPassword(req) {
  const required = process.env.EDIT_PASSWORD;
  if (!required) return true;
  const headers = req?.headers || {};
  return headers['x-edit-password'] === required;
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
  const data = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  if (!Array.isArray(data.tasks)) {
    throw new Error('data.json must contain a "tasks" array');
  }
  return { data, sha: file.sha };
}

async function writeDataset(data, sha, message) {
  const { token, owner, repo, path } = githubConfig();
  const content = Buffer.from(JSON.stringify(data, null, 2) + '\n').toString('base64');
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content, sha }),
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

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const taskId = decodeURIComponent(req.query?.id || '');

  try {
    if (!taskId) {
      if (req.method === 'GET') {
        const { data } = await readDataset();
        return res.status(200).json(data);
      }
      if (req.method === 'POST') {
        if (!checkEditPassword(req)) {
          return res.status(401).json({ error: 'Wrong or missing edit password' });
        }
        const data = await addTask(readBody(req));
        return res.status(201).json(data);
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (req.method === 'PUT') {
      if (!checkEditPassword(req)) {
        return res.status(401).json({ error: 'Wrong or missing edit password' });
      }
      const data = await updateTask(taskId, readBody(req));
      return res.status(200).json(data);
    }

    if (req.method === 'DELETE') {
      if (!checkEditPassword(req)) {
        return res.status(401).json({ error: 'Wrong or missing edit password' });
      }
      const data = await deleteTask(taskId);
      return res.status(200).json(data);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  }
}
