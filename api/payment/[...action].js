import create from "../_lib/routes/payment/create.js";
import status from "../_lib/routes/payment/status.js";
import returnHandler from "../_lib/routes/payment/return.js";
import verifySlip from "../_lib/routes/payment/verify-slip.js";

const handlers = { create, status, return: returnHandler, "verify-slip": verifySlip };

export default async function handler(req, res) {
  const raw = req.query?.action;
  const action = Array.isArray(raw) ? raw.join("/") : String(raw || "");
  const fn = handlers[action];
  if (!fn) return res.status(404).json({ error: "Payment route not found" });
  return fn(req, res);
}
