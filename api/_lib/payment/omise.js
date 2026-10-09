/*
Omise adapter (PromptPay). Only api/_lib/payment.js imports this file.
Keys: OMISE_PUBLIC_KEY (sources) / OMISE_SECRET_KEY (charges).
*/

const API = "https://api.omise.co";

function keys(PaymentError) {
  const publicKey = process.env.OMISE_PUBLIC_KEY;
  const secretKey = process.env.OMISE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    throw new PaymentError("ยังไม่ได้ตั้งค่า OMISE_PUBLIC_KEY / OMISE_SECRET_KEY ใน Vercel", 500, "config_missing");
  }
  return { publicKey, secretKey };
}

async function call(method, path, key, body, PaymentError) {
  const response = await fetch(API + path, {
    method,
    headers: {
      Authorization: "Basic " + Buffer.from(key + ":").toString("base64"),
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {})
    },
    body: body ? new URLSearchParams(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new PaymentError(data.message || "Omise error", 502, "omise_error");
  }
  return data;
}

export function isPaymentId(id) {
  return /^chrg_[A-Za-z0-9_]+$/.test(id);
}

export async function createPayment(order, { PRICE_SATANG, CURRENCY, PRODUCT, PaymentError }) {
  const { publicKey, secretKey } = keys(PaymentError);
  const source = await call("POST", "/sources", publicKey, {
    amount: String(PRICE_SATANG),
    currency: CURRENCY,
    type: "promptpay"
  }, PaymentError);
  const charge = await call("POST", "/charges", secretKey, {
    amount: String(PRICE_SATANG),
    currency: CURRENCY,
    source: source.id,
    description: "Stillwater 3 Cards",
    // Omise metadata uses bracket form fields: metadata[key]=value
    "metadata[orderId]": order.orderId,
    "metadata[firstCard]": String(order.card1),
    "metadata[product]": PRODUCT
  }, PaymentError);
  const qr = charge.source?.scannable_code?.image?.download_uri || "";
  if (!qr) throw new PaymentError("Omise ไม่ได้ส่ง QR กลับมา", 502, "no_qr");
  return {
    paymentId: charge.id,
    qr,
    qrPayload: null,
    amount: PRICE_SATANG,
    currency: CURRENCY,
    mode: secretKey.includes("_test_") ? "test" : "live"
  };
}

export async function getPaymentStatus(paymentId, { PaymentError }) {
  const { secretKey } = keys(PaymentError);
  const charge = await call("GET", "/charges/" + encodeURIComponent(paymentId), secretKey, null, PaymentError);
  if (charge.object !== "charge") throw new PaymentError("ตรวจการจ่ายไม่สำเร็จ", 502, "not_a_charge");
  return {
    paid: charge.status === "successful",
    status: charge.status,
    amount: charge.amount,
    currency: charge.currency,
    orderId: charge.metadata?.orderId || null
  };
}
