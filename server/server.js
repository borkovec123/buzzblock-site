// server/server.js
require('dotenv').config({ path: __dirname + '/.env' });

const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

// Optional: GA4 MP
const gaMeasurementId = process.env.GA4_MEASUREMENT_ID || '';
const gaApiSecret = process.env.GA4_API_SECRET || '';

// MGID postback base (you hardcoded 911140 before; keep in env if you prefer)
const mgidPostbackId = process.env.MGID_POSTBACK_ID || '911140';

if (!stripeSecretKey) {
  console.error('FATAL: STRIPE_SECRET_KEY env var is missing');
  process.exit(1);
}

console.log('Loaded STRIPE_SECRET_KEY:', true);
console.log('Loaded STRIPE_WEBHOOK_SECRET:', !!webhookSecret);
console.log('Loaded GA4_MEASUREMENT_ID:', !!gaMeasurementId);
console.log('Loaded GA4_API_SECRET:', !!gaApiSecret);
console.log('Loaded MGID_POSTBACK_ID:', mgidPostbackId);

const stripe = Stripe(stripeSecretKey);
const app = express();

/**
 * OPTIONAL helper: send purchase event to GA4 via Measurement Protocol.
 */
async function sendGa4Purchase({ mgidClickId, bundle, payout, currency }) {
  if (!gaMeasurementId || !gaApiSecret) {
    console.log('GA4 env not configured, skipping GA4 MP event');
    return;
  }

  const url =
    `https://www.google-analytics.com/mp/collect` +
    `?measurement_id=${encodeURIComponent(gaMeasurementId)}` +
    `&api_secret=${encodeURIComponent(gaApiSecret)}`;

  const clientId = mgidClickId || `srv-${Date.now()}`;

  const body = {
    client_id: clientId,
    user_id: mgidClickId || undefined,
    events: [
      {
        name: 'purchase',
        params: {
          value: payout,
          currency,
          items: [
            {
              item_name: 'BuzzBlock',
              quantity: Number(bundle) || 1,
            },
          ],
        },
      },
    ],
  };

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    console.log('GA4 MP status:', resp.status, 'body:', text);
  } catch (err) {
    console.error('GA4 MP error:', err.message);
  }
}

/**
 * Send MGID S2S postback
 */
async function sendMgidPostback({ mgidClickId, payout }) {
  if (!mgidClickId) {
    console.log('MGID: no click id, skipping postback');
    return;
  }

  // Your prior format:
  // https://a.mgid.com/postback/911140?c=CLICKID&e=purchase&r=VALUE
  const mgidUrl =
    `https://a.mgid.com/postback/${encodeURIComponent(mgidPostbackId)}` +
    `?c=${encodeURIComponent(mgidClickId)}` +
    `&e=purchase` +
    `&r=${encodeURIComponent(payout)}`;

  console.log('→ MGID postback:', mgidUrl);

  try {
    const r = await fetch(mgidUrl);
    const body = await r.text();
    console.log('MGID response status:', r.status);
    console.log('MGID response body:', body);
  } catch (err) {
    console.error('MGID postback error:', err.message);
  }
}

// ──────────────────────────────────────────────
// 1) Webhook endpoint – MUST be raw body for Stripe signature verification
// ──────────────────────────────────────────────
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    if (!webhookSecret) {
      console.warn('⚠️ STRIPE_WEBHOOK_SECRET is not set – rejecting webhook.');
      return res.status(400).send('Webhook secret not configured');
    }
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // We only want “paid only” → payment_intent.succeeded is the cleanest trigger.
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;

      const mgidClickId = pi.metadata?.mgid_clickid || '';
      const bundle = pi.metadata?.bundle || '';
      const currency = (pi.currency || 'myr').toLowerCase();

      // amount_received is the “actually received” value; fall back to amount
      const amount = typeof pi.amount_received === 'number' ? pi.amount_received : pi.amount;
      const payout = (amount || 0) / 100;

      const alreadySent = pi.metadata?.mgid_postback_sent === '1';

      console.log('✅ payment_intent.succeeded');
      console.log('  pi:', pi.id);
      console.log('  mgidClickId:', mgidClickId);
      console.log('  bundle:', bundle);
      console.log('  payout:', payout, currency);
      console.log('  mgid_postback_sent:', alreadySent);

      if (!alreadySent) {
        // Fire MGID + GA4
        await Promise.all([
          sendMgidPostback({ mgidClickId, payout }),
          sendGa4Purchase({ mgidClickId, bundle, payout, currency }),
        ]);

        // Persist “sent” flag in Stripe so it survives server restarts and prevents duplicates.
        try {
          await stripe.paymentIntents.update(pi.id, {
            metadata: {
              ...pi.metadata,
              mgid_postback_sent: '1',
            },
          });
          console.log('✅ Marked PI metadata mgid_postback_sent=1');
        } catch (e) {
          console.error('⚠️ Could not update PI metadata (still OK):', e.message);
        }
      } else {
        console.log('↩️ Skipping MGID/GA4: already sent for this PaymentIntent');
      }
    } else if (event.type === 'checkout.session.completed') {
      // Keep this for logging/debug only. Do NOT send MGID from here.
      const session = event.data.object;
      console.log('ℹ️ checkout.session.completed', {
        id: session.id,
        payment_status: session.payment_status,
        status: session.status,
        payment_intent: session.payment_intent,
      });
    } else if (event.type === 'checkout.session.async_payment_succeeded') {
      // Optional logging. PaymentIntent.succeeded will still be your “paid” trigger.
      const session = event.data.object;
      console.log('ℹ️ checkout.session.async_payment_succeeded', {
        id: session.id,
        payment_intent: session.payment_intent,
      });
    } else if (event.type === 'checkout.session.async_payment_failed') {
      const session = event.data.object;
      console.log('ℹ️ checkout.session.async_payment_failed', {
        id: session.id,
        payment_intent: session.payment_intent,
      });
    } else {
      console.log('Ignored event type:', event.type);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('❌ Webhook handler error:', err);
    return res.status(500).send('Webhook handler error');
  }
});

// ──────────────────────────────────────────────
// 2) Normal middleware (AFTER webhook)
// ──────────────────────────────────────────────
app.use(express.json());

// Keep CORS simple for now. Tighten later if needed.
app.use(
  cors({
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  })
);

// Health-check
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Stripe Prices: Map bundles → Stripe price IDs
const PRICE_MAP = {
  '1': process.env.STRIPE_PRICE_1,
  '2': process.env.STRIPE_PRICE_2,
  '3': process.env.STRIPE_PRICE_3,
  '4': process.env.STRIPE_PRICE_4,
  '5': process.env.STRIPE_PRICE_5,
};

console.log('PRICE_MAP presence:', {
  '1': !!PRICE_MAP['1'],
  '2': !!PRICE_MAP['2'],
  '3': !!PRICE_MAP['3'],
  '4': !!PRICE_MAP['4'],
  '5': !!PRICE_MAP['5'],
});

app.post('/create-session', async (req, res) => {
  console.log('--- /create-session called ---');
  console.log('Body:', req.body);

  const { bundle, tracking = {}, customer = {} } = req.body || {};

  if (!bundle) {
    return res.status(400).json({ error: 'Missing bundle selection' });
  }

  const priceId = PRICE_MAP[bundle];
  if (!priceId) {
    return res
      .status(400)
      .json({ error: 'Invalid bundle or missing STRIPE_PRICE env' });
  }

  const mgidClickId = tracking.mgid_clickid || '';

try {
  const shippingOptions =
    bundle === '1'
      ? [
          {
            shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: { amount: 999, currency: 'myr' }, // RM 9.99
              display_name: 'Shipping (3–7 day delivery)',
              delivery_estimate: {
                minimum: { unit: 'business_day', value: 3 },
                maximum: { unit: 'business_day', value: 7 },
              },
            },
          },
        ]
      : [
          {
            shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: { amount: 0, currency: 'myr' },
              display_name: 'FREE Shipping (3–7 day delivery)',
              delivery_estimate: {
                minimum: { unit: 'business_day', value: 3 },
                maximum: { unit: 'business_day', value: 7 },
              },
            },
          },
        ];

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    ui_mode: 'embedded',

    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],

    // Shipping address collection (Malaysia)
    shipping_address_collection: {
      allowed_countries: ['MY'],
    },

    // Shipping option (conditional)
    shipping_options: shippingOptions,

      // Phone number in checkout
      phone_number_collection: { enabled: true },

      // Optional: prefills email
      customer_email: customer.email || undefined,

      // IMPORTANT: put tracking into BOTH session.metadata and payment_intent_data.metadata
      metadata: {
        mgid_clickid: mgidClickId,
        bundle,
        customer_name: customer.name || '',
      },

      // THIS is what makes payment_intent.succeeded carry your MGID click id.
      payment_intent_data: {
        metadata: {
          mgid_clickid: mgidClickId,
          bundle,
          customer_name: customer.name || '',
          mgid_postback_sent: '0',
        },
      },

      return_url:
        'https://buzzblock.shop/thankyou.html?session_id={CHECKOUT_SESSION_ID}',
    });

    console.log('✅ Created Session:', session.id);

    res.json({
      clientSecret: session.client_secret,
      sessionId: session.id,
    });
  } catch (err) {
    console.error('❌ Stripe error in /create-session:', err);
    res.status(500).json({
      error: 'Stripe error',
      message: err && err.message ? err.message : 'Payment configuration error',
    });
  }
});

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 BuzzBlock server listening on port ${PORT}`);
});
