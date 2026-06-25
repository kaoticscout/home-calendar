/**
 * The Home Almanac — local dev server
 * Serves static files and persists task CRUD to data.json.
 */

const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function readDataset() {
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data.tasks)) {
    throw new Error('data.json must contain a "tasks" array');
  }
  return data;
}

async function writeDataset(data) {
  const content = JSON.stringify(data, null, 2) + '\n';
  await fs.writeFile(DATA_FILE, content, 'utf8');
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendText(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return null;
  return JSON.parse(raw);
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

async function serveStatic(req, res, pathname) {
  let filePath = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);

  if (!filePath.startsWith(ROOT)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/tasks' && req.method === 'GET') {
    const data = await readDataset();
    sendJson(res, 200, data);
    return;
  }

  if (pathname === '/api/tasks' && req.method === 'POST') {
    const task = await readJsonBody(req);
    if (!isValidTask(task)) {
      sendJson(res, 400, { error: 'Invalid task payload' });
      return;
    }

    const data = await readDataset();
    if (data.tasks.some(t => t.id === task.id)) {
      sendJson(res, 409, { error: `Task id already exists: ${task.id}` });
      return;
    }

    data.tasks.push({
      id: task.id,
      name: task.name.trim(),
      category: task.category,
      schedule: task.schedule,
      notes: typeof task.notes === 'string' ? task.notes : '',
    });
    await writeDataset(data);
    sendJson(res, 201, data);
    return;
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch) {
    const taskId = decodeURIComponent(taskMatch[1]);

    if (req.method === 'PUT') {
      const task = await readJsonBody(req);
      if (!isValidTask(task) || task.id !== taskId) {
        sendJson(res, 400, { error: 'Invalid task payload or id mismatch' });
        return;
      }

      const data = await readDataset();
      const idx = data.tasks.findIndex(t => t.id === taskId);
      if (idx === -1) {
        sendJson(res, 404, { error: 'Task not found' });
        return;
      }

      data.tasks[idx] = {
        id: taskId,
        name: task.name.trim(),
        category: task.category,
        schedule: task.schedule,
        notes: typeof task.notes === 'string' ? task.notes : (data.tasks[idx].notes ?? ''),
      };
      await writeDataset(data);
      sendJson(res, 200, data);
      return;
    }

    if (req.method === 'DELETE') {
      const data = await readDataset();
      const before = data.tasks.length;
      data.tasks = data.tasks.filter(t => t.id !== taskId);
      if (data.tasks.length === before) {
        sendJson(res, 404, { error: 'Task not found' });
        return;
      }
      await writeDataset(data);
      sendJson(res, 200, data);
      return;
    }
  }

  sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
      return;
    }

    await serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message || 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`The Home Almanac running at http://localhost:${PORT}`);
  console.log(`Tasks API: http://localhost:${PORT}/api/tasks`);
  console.log(`Origin backup: data.origin.json (unchanged)`);
});
