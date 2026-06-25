module.exports = (req, res) => {
  res.status(200).json({
    ok: true,
    hasGithubToken: Boolean(process.env.GITHUB_TOKEN),
    hasEditPassword: Boolean(process.env.EDIT_PASSWORD),
  });
};
