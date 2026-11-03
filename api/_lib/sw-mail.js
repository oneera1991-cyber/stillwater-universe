/* Email adapter. RESEND_API_KEY + SW_MAIL_FROM → Resend. Without a key: dev mode (code logged; returned to the
   page ONLY outside production). TODO(Palm): sign up for the email service and choose the sender address. */
export const mailMode = () => (process.env.RESEND_API_KEY ? "resend" : "dev");
export const devCodesAllowed = () => mailMode() === "dev" && process.env.VERCEL_ENV !== "production";
let sender = null;
export function setSenderForTesting(fn) { sender = fn; }
export async function sendCode(email, code) {
  const subject = "รหัสเข้าสู่ Stillwater ของคุณ";
  const text = `รหัสของคุณคือ ${code}\nใช้ได้ภายใน 10 นาทีนะคะ\n\nถ้าคุณไม่ได้ขอรหัสนี้ ปล่อยผ่านได้เลยค่ะ`;
  if (sender) return sender({ email, code, subject, text });
  if (mailMode() === "dev") { console.log(`[sw-mail DEV MODE] code for ${email.replace(/(.).*@/, "$1***@")}: ${code}`); return { ok: true, dev: true }; }
  const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: "Bearer " + process.env.RESEND_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ from: process.env.SW_MAIL_FROM || "Stillwater <onboarding@resend.dev>", to: [email], subject, text }), signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("mail " + r.status);
  return { ok: true };
}
