import crypto from "crypto";

const ENDPOINT =
  process.env.TWOC2P_ENV === "production"
    ? "https://pgw.2c2p.com/payment/4.5/paymentInquiry"
    : "https://sandbox-pgw.2c2p.com/payment/4.5/paymentInquiry";

function b64(input){

  return Buffer
    .from(input)
    .toString("base64")
    .replace(/=/g,"")
    .replace(/\+/g,"-")
    .replace(/\//g,"_");

}

function jwt(payload,secret){

  const header =
    b64(
      JSON.stringify({
        alg:"HS256",
        typ:"JWT"
      })
    );

  const body =
    b64(
      JSON.stringify(payload)
    );

  const unsigned =
    `${header}.${body}`;

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

function decode(token){

  const parts =
    token.split(".");

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

  if(req.method !== "GET"){

    return res
      .status(405)
      .json({
        error:"Method not allowed"
      });

  }

  const invoice =
    req.query?.invoice;

  if(!invoice){

    return res
      .status(400)
      .json({
        error:"Missing invoice"
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
        error:"Payment configuration missing"
      });

  }

  try{

    const payload =
      jwt(
        {
          merchantID,
          invoiceNo:invoice,
          locale:"th"
        },
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
              payload
            })
        }
      );

    const data =
      await response.json();

    if(!data.payload){

      throw new Error(
        "No payment response"
      );

    }

    const payment =
      decode(
        data.payload
      );

    const paid =
      payment.respCode === "0000" &&
      Number(payment.amount) === 59 &&
      payment.currencyCode === "THB";

    return res
      .status(200)
      .json({

        ok:true,

        paid,

        invoice,

        respCode:
          payment.respCode,

        respDesc:
          payment.respDesc

      });

  }catch(error){

    console.error(
      "PAYMENT STATUS ERROR",
      error
    );

    return res
      .status(500)
      .json({
        error:
          error.message ||
          "Payment status failed"
      });

  }

}
