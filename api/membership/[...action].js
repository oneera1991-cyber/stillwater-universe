import activate from "../_lib/routes/membership/activate.js";
import create from "../_lib/routes/membership/create.js";
import login from "../_lib/routes/membership/login.js";
import me from "../_lib/routes/membership/me.js";
import requestCode from "../_lib/routes/membership/request-code.js";
import status from "../_lib/routes/membership/status.js";
import verifySlip from "../_lib/routes/membership/verify-slip.js";

const handlers = {
  activate,
  create,
  login,
  me,
  "request-code": requestCode,
  status,
  "verify-slip": verifySlip,
};

export default async function handler(req, res) {
  const raw = req.query?.action;
  const action = Array.isArray(raw) ? raw.join("/") : String(raw || "");
  const fn = handlers[action];
  if (!fn) return res.status(404).json({ error: "Membership route not found" });
  return fn(req, res);
}
