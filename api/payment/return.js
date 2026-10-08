export default async function handler(req, res) {
  const chargeId = req.query?.charge || "";
  const origin = "https://" + req.headers.host;
  if (!chargeId) {
    return res.redirect(303, origin + "/?payment=missing");
  }
  return res.redirect(303, origin + "/?payment=pending&charge=" + encodeURIComponent(chargeId));
}
