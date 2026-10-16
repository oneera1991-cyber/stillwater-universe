import { verifyMembershipToken, activateMember, MEMBERSHIP_PRICE_SATANG } from '../../membership.js';
import { verifyPaid } from '../../order.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');
    const purchase = verifyMembershipToken(body.purchase);
    if (purchase.kind !== 'purchase') throw new Error('membership_purchase_invalid');
    const paid = verifyPaid(body.paid);
    if (paid.orderId !== purchase.purchaseId || Number(paid.amount) !== MEMBERSHIP_PRICE_SATANG) throw new Error('membership_payment_invalid');
    const out = await activateMember({
      email: String(body.email || ''),
      birthDate: String(body.birthDate || ''),
      birthTime: String(body.birthTime || ''),
      paymentRef: paid.ref
    });
    return res.json({
      ok: true,
      member: { email: out.member.email, birthDate: out.member.birthDate, birthTime: out.member.birthTime, expiresAt: out.member.expiresAt },
      token: out.token
    });
  } catch (e) {
    return res.status(400).json({ ok: false, code: e?.message || 'membership_activate_failed' });
  }
}
