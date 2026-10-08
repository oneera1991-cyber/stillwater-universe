const PRICE = 5900;

function keys() {
  const publicKey = process.env.OMISE_PUBLIC_KEY;
  const secretKey = process.env.OMISE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    const error = new Error("ยังไม่ได้ตั้งค่า OMISE_PUBLIC_KEY / OMISE_SECRET_KEY ใน Vercel");
    error.status = 500;
    throw error;
  }
  return { publicKey, secretKey };
}

async function omise(path, key, body) {
  const response = await fetch("https://api.omise.co" + path, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(key + ":").toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(body)
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.message || "Omise error");
    error.status = 502;
    throw error;
  }
  return data;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { publicKey, secretKey } = keys();
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const source = await omise("/sources", publicKey, {
      amount: String(PRICE),
      currency: "THB",
      type: "promptpay"
    });
    const charge = await omise("/charges", secretKey, {
      amount: String(PRICE),
      currency: "THB",
      source: source.id,
      description: "Stillwater 3 Cards",
      metadata: JSON.stringify({
        firstCard: String(body.firstCard?.id || "").slice(0, 80),
        product: "STILLWATER_DEEPER_3"
      })
    });
    const qr = charge.source?.scannable_code?.image?.download_uri || "";
    if (!qr) {
      return res.status(502).json({ error: "Omise ไม่ได้ส่ง QR กลับมา" });
    }
    return res.status(200).json({
      ok: true,
      chargeId: charge.id,
      qr,
      amount: 59,
      mode: secretKey.includes("_test_") ? "test" : "live"
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      error: error.message || "สร้างรายการชำระเงินไม่สำเร็จ"
    });
  }
}
