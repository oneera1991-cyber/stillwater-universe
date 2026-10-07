import crypto from "crypto";

const ENDPOINT =
  process.env.TWOC2P_ENV === "production"
    ? "https://pgw.2c2p.com/payment/4.5/paymentInquiry"
    : "https://sandbox-pgw.2c2p.com/payment/4.5/paymentInquiry";

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
    alg:"HS256",
    typ:"JWT"
  };

  const h =
    base64url(
      JSON.stringify(header)
    );

  const p =
    base64url(
      JSON.stringify(payload)
    );

  const unsigned =
    `${h}.${p}`;

  const signature =
    crypto
      .createHmac(
        "sha256",
        secret
      )
      .update(unsigned)
      .digest("base64")
      .replace(/=/g,"")
      .replace(/\+/g,"-")
      .replace(/\//g,"_");

  return `${unsigned}.${signature}`;
}

function decodeJWT(token){

  const parts =
    token.split(".");

  if(parts.length!==3)
    throw new Error("Invalid JWT");

  return JSON.parse(
    Buffer.from(
      parts[1]
        .replace(/-/g,"+")
        .replace(/_/g,"/"),
      "base64"
    ).toString("utf8")
  );

}

export default async function handler(req,res){

  if(req.method !== "POST"){

    return res
      .status(405)
      .send("Method not allowed");

  }

  const merchantID =
    process.env.TWOC2P_MERCHANT_ID;

  const secret =
    process.env.TWOC2P_SECRET_KEY;

  if(!merchantID || !secret){

    return res
      .status(500)
      .send("Payment configuration missing");

  }

  try{

    const paymentResponse =
      req.body?.paymentResponse;

    if(!paymentResponse){

      return res
        .status(400)
        .send("Missing paymentResponse");

    }

    /*
      Decode frontend response first.
    */

    const decoded =
      decodeJWT(
        decodeURIComponent(
          paymentResponse
        )
      );

    const invoiceNo =
      decoded.invoiceNo;

    if(!invoiceNo){

      return res
        .status(400)
        .send("Missing invoice number");

    }

    /*
      Ask 2C2P for the authoritative
      payment status.
    */

    const inquiryPayload = {

      merchantID,

      invoiceNo,

      locale:"th"

    };

    const jwt =
      createJWT(
        inquiryPayload,
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

    if(!data.payload){

      throw new Error(
        "No inquiry payload"
      );

    }

    const payment =
      decodeJWT(
        data.payload
      );

    /*
      Only 0000 = successful payment.
    */

    const success =
      payment.respCode === "0000" &&
      Number(payment.amount) === 59 &&
      payment.currencyCode === "THB";

    const origin =
      `https://${req.headers.host}`;

    if(success){

      return res.redirect(
        303,
        `${origin}/?payment=success&invoice=${encodeURIComponent(invoiceNo)}`
      );

    }

    return res.redirect(
      303,
      `${origin}/?payment=failed&invoice=${encodeURIComponent(invoiceNo)}`
    );

  }catch(error){

    console.error(
      "2C2P RETURN ERROR",
      error
    );

    return res.redirect(
      303,
      `/?payment=error`
    );

  }

}
