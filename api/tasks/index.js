const { handleCors, sendJson, readBody, checkEditPassword } = require('../../lib/http');
const { getTasks, addTask } = require('../../lib/github-data');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    if (req.method === 'GET') {
      const data = await getTasks();
      return sendJson(res, 200, data);
    }

    if (req.method === 'POST') {
      if (!checkEditPassword(req)) {
        return sendJson(res, 401, { error: 'Wrong or missing edit password' });
      }

      const task = readBody(req);
      const data = await addTask(task);
      return sendJson(res, 201, data);
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    const status = err.status || 500;
    return sendJson(res, status, { error: err.message || 'Internal server error' });
  }
};
