import crypto from "crypto";

const ENDPOINT =
  process.env.TWOC2P_ENV === "production"
    ? "https://pgw.2c2p.com/payment/4.5/paymentToken"
    : "https://sandbox-pgw.2c2p.com/payment/4.5/paymentToken";

function base64url(input) {
  return Buffer
    .from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function createJWT(payload, secret) {
  const header = {
    alg: "HS256",
    typ: "JWT"
  };

  const encodedHeader =
    base64url(
      JSON.stringify(header)
    );

  const encodedPayload =
    base64url(
      JSON.stringify(payload)
    );

  const unsigned =
    `${encodedHeader}.${encodedPayload}`;

  const signature =
    crypto
      .createHmac(
        "sha256",
        secret
      )
      .update(unsigned)
      .digest("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

  return `${unsigned}.${signature}`;
}

function decodeJWT(token) {
  const parts =
    token.split(".");

  if(parts.length !== 3)
    throw new Error("Invalid JWT");

  return JSON.parse(
    Buffer
      .from(
        parts[1]
          .replace(/-/g, "+")
          .replace(/_/g, "/"),
        "base64"
      )
      .toString("utf8")
  );
}

export default async function handler(req, res) {

  if(req.method !== "POST"){

    return res
      .status(405)
      .json({
        error:"Method not allowed"
      });

  }

  const merchantID =
    process.env.TWOC2P_MERCHANT_ID;

  const secret =
    process.env.TWOC2P_SECRET_KEY;

  if(!merchantID || !secret){

    return res
      .status(500)
      .json({
        error:
          "ยังไม่ได้ตั้งค่า 2C2P Merchant ID / Secret Key ใน Vercel"
      });

  }

  try{

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body || {};

    /*
      ราคาถูกล็อกที่ backend
      ห้ามเชื่อ amount จาก frontend
    */

    const amount = 59;

    const invoiceNo =
      `SW${Date.now()}${crypto
        .randomBytes(3)
        .toString("hex")
        .toUpperCase()}`;

    const origin =
      `https://${req.headers.host}`;

    /*
      2C2P Payment Token request
    */

    const payload = {

      merchantID,

      invoiceNo,

      description:
        "Stillwater 3 Cards",

      amount,

      currencyCode:
        "THB",

      /*
        เปิดช่องทางที่ merchant
        ได้รับอนุมัติจาก 2C2P
      */
      paymentChannel: [
        "CC",
        "QR",
        "APM"
      ],

      locale:
        "th",

      frontendReturnUrl:
        `${origin}/api/payment/return`,

      backendReturnUrl:
        `${origin}/api/payment/return`,

      nonceStr:
        crypto
          .randomBytes(16)
          .toString("hex"),

      immediatePayment:
        false,

      /*
        เก็บ first card id ไว้
        สำหรับเชื่อมกับ paid session
      */
      userDefined1:
        String(
          body.firstCard?.id ||
          ""
        ).slice(0,150),

      userDefined2:
        "STILLWATER_DEEPER_3"

    };

    const jwt =
      createJWT(
        payload,
        secret
      );

    const response =
      await fetch(
        ENDPOINT,
        {
          method:"POST",

          headers:{
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              payload:jwt
            })
        }
      );

    const data =
      await response.json();

    if(!response.ok){

      return res
        .status(502)
        .json({
          error:
            "2C2P payment service error",
          details:data
        });

    }

    if(!data.payload){

      return res
        .status(502)
        .json({
          error:
            "2C2P ไม่ได้ส่ง payment payload กลับมา"
        });

    }

    const decoded =
      decodeJWT(
        data.payload
      );

    if(
      decoded.respCode !== "0000"
    ){

      return res
        .status(400)
        .json({
          error:
            decoded.respDesc ||
            "สร้างรายการชำระเงินไม่สำเร็จ",
          code:
            decoded.respCode
        });

    }

    return res
      .status(200)
      .json({

        ok:true,

        invoiceNo,

        paymentToken:
          decoded.paymentToken,

        webPaymentUrl:
          decoded.webPaymentUrl

      });

  }catch(error){

    console.error(
      "2C2P CREATE ERROR",
      error
    );

    return res
      .status(500)
      .json({
        error:
          error.message ||
          "Payment creation failed"
      });

  }

}
