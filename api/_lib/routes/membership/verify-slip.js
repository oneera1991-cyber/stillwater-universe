/*
POST /api/membership/verify-slip
multipart/form-data: purchase=<membership purchase token>, slip=<jpg|png <= 4MB>

This verifies the PromptPay slip for the 399 THB Unlimited purchase and returns
an order-bound signed paid token. The paid token is then consumed by the existing
membership activation route after the customer provides email + birth data.
*/
import { verifyMembershipToken, MEMBERSHIP_PRICE_SATANG, MEMBERSHIP_PRICE_THB } from '../../membership.js';
import { sniffImage, easyslipTimeoutMs } from '../../payment/promptpay-easyslip.js';
import { signPaid } from '../../order.js';

const MAX_BODY = 4.5 * 1024 * 1024;
const MAX_SLIP = 4 * 1024 * 1024;

async function readBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const type = String(req.headers['content-type'] || '');
    if (!type.startsWith('multipart/form-data')) {
      return res.status(400).json({ ok: false, reason: 'bad_file' });
    }

    if (Number(req.headers['content-length'] || 0) > MAX_BODY) {
      return res.status(400).json({ ok: false, reason: 'bad_file' });
    }

    const raw = await readBody(req);
    const form = await new Response(raw, {
      headers: { 'content-type': type }
    }).formData();

    const purchaseToken = String(form.get('purchase') || '');
    const purchase = verifyMembershipToken(purchaseToken);

    if (purchase.kind !== 'purchase') {
      throw new Error('membership_purchase_invalid');
    }

    const slip = form.get('slip');
    if (!slip || typeof slip.arrayBuffer !== 'function' || !slip.size || slip.size > MAX_SLIP) {
      return res.status(400).json({ ok: false, reason: 'bad_file' });
    }

    const bytes = Buffer.from(await slip.arrayBuffer());
    const mime = sniffImage(bytes);
    if (!mime || bytes.length > MAX_SLIP) {
      return res.status(400).json({ ok: false, reason: 'bad_file' });
    }

    const key = String(process.env.EASYSLIP_API_KEY || '');
    if (!key) {
      console.error('membership verify-slip: EASYSLIP_API_KEY is missing');
      return res.status(503).json({ ok: false, reason: 'service' });
    }

    const payload = new FormData();
    payload.append(
      'image',
      new Blob([bytes], { type: mime }),
      mime === 'image/png' ? 'slip.png' : 'slip.jpg'
    );
    payload.append('matchAmount', String(MEMBERSHIP_PRICE_THB));
    payload.append('matchAccount', 'true');
    payload.append('checkDuplicate', 'true');
    payload.append('remark', String(purchase.purchaseId).slice(0, 255));

    let response;
    try {
      response = await fetch('https://api.easyslip.com/v2/verify/bank', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: payload,
        signal: AbortSignal.timeout(easyslipTimeoutMs())
      });
    } catch (error) {
      console.error('membership EasySlip request failed:', error?.name || error);
      return res.status(503).json({ ok: false, reason: 'service' });
    }

    const body = await response.json().catch(() => null);

    if (body?.success !== true) {
      const code = String(body?.error?.code || '');
      if (code === 'QUOTA_EXCEEDED') {
        return res.status(503).json({ ok: false, reason: 'quota' });
      }
      if (['SLIP_NOT_FOUND', 'INVALID_IMAGE_FORMAT', 'IMAGE_SIZE_TOO_LARGE', 'VALIDATION_ERROR'].includes(code)) {
        return res.status(422).json({ ok: false, reason: 'unreadable' });
      }
      return res.status(503).json({ ok: false, reason: 'service' });
    }

    const data = body.data || {};
    if (data.isDuplicate !== false) {
      return res.status(409).json({ ok: false, reason: 'duplicate' });
    }
    if (data.isAmountMatched !== true || Number(data.amountInSlip) !== MEMBERSHIP_PRICE_THB) {
      return res.status(422).json({ ok: false, reason: 'wrong_amount' });
    }
    if (!data.matchedAccount) {
      return res.status(422).json({ ok: false, reason: 'wrong_account' });
    }

    const ref = String(data.rawSlip?.transRef || '');
    if (!ref) {
      return res.status(422).json({ ok: false, reason: 'unreadable' });
    }

    const paid = signPaid({
      orderId: purchase.purchaseId,
      method: 'membership-promptpay',
      ref,
      amount: MEMBERSHIP_PRICE_SATANG,
      currency: 'THB',
      slipDate: data.rawSlip?.date || null
    });

    return res.json({
      ok: true,
      paid,
      purchaseId: purchase.purchaseId,
      ref
    });
  } catch (error) {
    const code = String(error?.message || 'membership_payment_failed');
    console.error('membership verify-slip:', code);
    return res.status(400).json({
      ok: false,
      reason: code === 'too_large' ? 'bad_file' : code
    });
  }
}
