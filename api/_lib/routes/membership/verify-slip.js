export default async function handler(req, res) {
  return res.status(501).json({ ok: false, reason: 'not_implemented' });
}
