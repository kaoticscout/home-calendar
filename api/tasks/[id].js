const { handleCors, sendJson, readBody, checkEditPassword } = require('../lib/http');
const { updateTask, deleteTask } = require('../lib/github-data');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  const taskId = decodeURIComponent(req.query.id || '');

  try {
    if (req.method === 'PUT') {
      if (!checkEditPassword(req)) {
        return sendJson(res, 401, { error: 'Wrong or missing edit password' });
      }

      const task = readBody(req);
      const data = await updateTask(taskId, task);
      return sendJson(res, 200, data);
    }

    if (req.method === 'DELETE') {
      if (!checkEditPassword(req)) {
        return sendJson(res, 401, { error: 'Wrong or missing edit password' });
      }

      const data = await deleteTask(taskId);
      return sendJson(res, 200, data);
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    const status = err.status || 500;
    return sendJson(res, status, { error: err.message || 'Internal server error' });
  }
};
