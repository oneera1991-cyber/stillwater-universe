const PRICE = 5900;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const chargeId = req.query?.charge;
  const secretKey = process.env.OMISE_SECRET_KEY;
  if (!chargeId || !String(chargeId).startsWith("chrg_")) {
    return res.status(400).json({ error: "Missing charge" });
  }
  if (!secretKey) {
    return res.status(500).json({ error: "Payment configuration missing" });
  }

  try {
    const response = await fetch("https://api.omise.co/charges/" + chargeId, {
      headers: {
        Authorization: "Basic " + Buffer.from(secretKey + ":").toString("base64")
      }
    });
    const charge = await response.json();
    if (!response.ok) {
      return res.status(502).json({ error: charge.message || "ตรวจสถานะไม่สำเร็จ" });
    }
    const paid = charge.status === "successful" && charge.amount === PRICE && charge.currency === "THB";
    return res.status(200).json({
      ok: true,
      paid,
      status: charge.status,
      chargeId
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Payment status failed" });
  }
}
