const { handleCors, sendJson } = require('../lib/http');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;
  return sendJson(res, 200, {
    ok: true,
    hasGithubToken: Boolean(process.env.GITHUB_TOKEN),
    hasEditPassword: Boolean(process.env.EDIT_PASSWORD),
  });
};
