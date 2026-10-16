/*
GET /api/payment/return?payment=<id>   (legacy: ?charge=<id>)
Provider redirect target. Never claims success: it only sends the browser back
to the page, which resumes polling + /api/deeper (server-verified).
*/
export default async function handler(req, res) {
  const paymentId = String(req.query?.payment || req.query?.charge || "");
  const origin = "https://" + req.headers.host;
  if (!paymentId) {
    return res.redirect(303, origin + "/?payment=missing");
  }
  return res.redirect(303, origin + "/?payment=pending&pid=" + encodeURIComponent(paymentId));
}
