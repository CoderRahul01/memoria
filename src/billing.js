/**
 * Dodo Payments — one-time "Lifetime" unlock.
 * Checkout uses Dodo's static payment link with the family id in metadata; the signed
 * payment.succeeded webhook is what flips a family to lifetime (no API key on this server).
 */
const { Webhook } = require('standardwebhooks');
const { configured } = require('./env');

const PRODUCT_ID = configured('DODO_PRODUCT_ID');
const CHECKOUT_BASE = process.env.DODO_CHECKOUT_BASE || 'https://checkout.dodopayments.com/buy';
const WEBHOOK_SECRET = configured('DODO_WEBHOOK_SECRET');
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://memoria-family.vercel.app';

const PRICE_LABEL = '$19';
// Free is generous; the paywall sits where our costs are (voice storage, transcription quality, AI volume).
const FREE_LIMITS = { persons: 2, memories: 30, voice_minutes: 60, asks_per_day: 20, record_minutes: 10, keepsake: false };
const LIFETIME_LIMITS = { persons: null, memories: null, voice_minutes: 1200, asks_per_day: 200, record_minutes: 30, keepsake: true };

const enabled = () => !!(PRODUCT_ID && WEBHOOK_SECRET);

function checkoutUrl(family) {
  const params = new URLSearchParams({
    quantity: '1',
    redirect_url: `${PUBLIC_URL}/?paid=1#home`,
    metadata_family_id: family.id
  });
  return `${CHECKOUT_BASE}/${PRODUCT_ID}?${params}`;
}

/** Verifies the Standard Webhooks signature and returns the parsed event, or throws. */
function verify(rawBody, headers) {
  const wh = new Webhook(WEBHOOK_SECRET);
  return wh.verify(rawBody, {
    'webhook-id': headers['webhook-id'],
    'webhook-signature': headers['webhook-signature'],
    'webhook-timestamp': headers['webhook-timestamp']
  });
}

module.exports = { enabled, checkoutUrl, verify, PRICE_LABEL, FREE_LIMITS, LIFETIME_LIMITS, PRODUCT_ID };
