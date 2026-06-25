export const config = { runtime: 'edge' };

export default function handler() {
  return Response.json({
    ok: true,
    hasGithubToken: Boolean(process.env.GITHUB_TOKEN),
    hasEditPassword: Boolean(process.env.EDIT_PASSWORD),
  });
}
