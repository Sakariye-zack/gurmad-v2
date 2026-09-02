// Phase 4 — Customer Portal — WhatsApp delivery abstraction. Approved via
// OD-6: WhatsApp is the approved password-reset delivery channel, but the
// authentication core must stay independent of the specific provider —
// this file is the ONE place a provider is wired in. No provider
// credentials exist in this environment today (confirmed: no WhatsApp
// Business API / Twilio / Meta credentials anywhere in server/.env*), so
// this module does NOT fake delivery — it reports its own "not configured"
// state honestly, and the caller (routes/customerPortal.js) must not claim
// delivery succeeded when it didn't.

const PROVIDER_CONFIGURED = Boolean(
  process.env.WHATSAPP_PROVIDER_API_URL && process.env.WHATSAPP_PROVIDER_API_KEY
);

// dispatchResult: { dispatched: boolean, configured: boolean, providerMessageId: string|null, error: string|null }
// "dispatched" means the application successfully HANDED the message to a
// configured provider's API and got a 2xx — it is NOT proof the message
// was delivered to the recipient's phone (that would require a provider
// delivery-webhook, out of scope here and explicitly not claimed anywhere
// in this codebase per the Implementation Spec's testing discipline).
async function sendPasswordResetWhatsApp({ toPhone, resetToken, resetUrl }) {
  if (!PROVIDER_CONFIGURED) {
    console.warn(
      `[whatsappService] WhatsApp provider not configured (WHATSAPP_PROVIDER_API_URL / ` +
      `WHATSAPP_PROVIDER_API_KEY missing from environment). Password-reset message for ` +
      `${toPhone} was NOT sent. Configure these env vars to enable delivery.`
    );
    return { dispatched: false, configured: false, providerMessageId: null, error: 'WhatsApp provider not configured.' };
  }

  try {
    const res = await fetch(`${process.env.WHATSAPP_PROVIDER_API_URL}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.WHATSAPP_PROVIDER_API_KEY}`,
      },
      body: JSON.stringify({
        to: toPhone,
        template: 'customer_portal_password_reset',
        params: { reset_url: resetUrl },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { dispatched: false, configured: true, providerMessageId: null, error: `Provider returned ${res.status}: ${text}` };
    }
    const body = await res.json().catch(() => ({}));
    return { dispatched: true, configured: true, providerMessageId: body.messageId || body.id || null, error: null };
  } catch (err) {
    return { dispatched: false, configured: true, providerMessageId: null, error: err.message };
  }
}

module.exports = { sendPasswordResetWhatsApp, PROVIDER_CONFIGURED };
