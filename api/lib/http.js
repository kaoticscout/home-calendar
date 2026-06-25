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

function resolveOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return allowedOrigins()[0];
  if (allowedOrigins().includes(origin)) return origin;
  return null;
}

function handleCors(req, res) {
  const origin = resolveOrigin(req);
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Edit-Password');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.trim()) return JSON.parse(req.body);
  return null;
}

function checkEditPassword(req) {
  const required = process.env.EDIT_PASSWORD;
  if (!required) return true;
  return req.headers['x-edit-password'] === required;
}

module.exports = {
  handleCors,
  sendJson,
  readBody,
  checkEditPassword,
};
