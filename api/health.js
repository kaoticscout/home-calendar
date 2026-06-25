module.exports = (req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    ok: true,
    hasGithubToken: Boolean(process.env.GITHUB_TOKEN),
    hasEditPassword: Boolean(process.env.EDIT_PASSWORD),
  }));
};
