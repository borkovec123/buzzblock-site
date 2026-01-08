// server/server.js
require('dotenv').config({ path: __dirname + '/.env' });

const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

const gaMeasurementId = process.env.GA4_MEASUREMENT_ID || '';
const gaApiSecret = process.env.GA4_API_SECRET || '';

if (!stripeSecretKey) {
  console.error('FATAL: STRIPE_SECRET_KEY env var is missing');
  process.exit(1);
}

console.log('Loaded STRIPE_SECRET_KEY:', true);
console.log('Loaded STRIPE_WEBHOOK_SECRET:', !!webhookSecret);
console.log('Loaded GA4_MEASUREMENT_ID:', !!gaMeasurementId);
console.log('Loaded GA4_API_SECRET:', !!gaApiSecret);

const stripe = Stripe(stripeSecretKey);
const app = express();

/**
 * Helper: send purchase event to GA4 via Measurement Protocol.
 * This is OPTIONAL – if GA envs are not set, it just logs and skips.
 */
async function sendGa4Purchase({
  mgidClickId,
  bundle,
  payout,
  currency
}) {
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
              quantity: Number(bundle) || 1
            }
          ],
          // You can add more params if you want:
          // coupon, shipping, tax, transaction_id, etc.
        }
      }
    ]
  };

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const text = await resp.text();
    console.log('GA4 MP status:', resp.status, 'body:', text);
  } catch (err) {
    console.error('GA4 MP error:', err.message);
  }
}

// ──────────────────────────────────────────────
// 1) Webhook endpoint – raw body for Stripe
// ──────────────────────────────────────────────
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];

    let event;
    try {
      if (!webhookSecret) {
        console.warn(
          '⚠️ STRIPE_WEBHOOK_SECRET is not set – rejecting webhook.'
        );
        return res.status(400).send('Webhook secret not configured');
      }

      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error('❌ Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      const mgidClickId = session.metadata?.mgid_clickid || '';
      const bundle = session.metadata?.bundle || '';
      const amountTotal = session.amount_total || 0; // in sen
      const currency = session.currency; // "myr"

      const payout = amountTotal / 100; // e.g. 148.00

      console.log('✅ checkout.session.completed');
      console.log('  mgidClickId:', mgidClickId);
      console.log('  bundle:', bundle);
      console.log('  payout:', payout, currency);

      const tasks = [];

      // MGID S2S
      if (mgidClickId) {
        const mgidUrl =
          'https://a.mgid.com/postback/911140' +
          `?c=${encodeURIComponent(mgidClickId)}` +
          `&e=purchase` +
          `&r=${encodeURIComponent(payout)}`;

        console.log('→ MGID postback:', mgidUrl);

        tasks.push(
          fetch(mgidUrl)
            .then((r) => r.text())
            .then((body) => {
              console.log('MGID response:', body);
            })
            .catch((err) => {
              console.error('MGID postback error:', err.message);
            })
        );
      }

      // GA4 server-side purchase event
      tasks.push(
        sendGa4Purchase({
          mgidClickId,
          bundle,
          payout,
          currency
        })
      );

      await Promise.all(tasks);
    } else {
      console.log('Ignored event type:', event.type);
    }

    res.json({ received: true });
  }
);

// ──────────────────────────────────────────────
// 2) Normal middleware
// ──────────────────────────────────────────────
app.use(express.json());
app.use(cors());

// Health-check
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Stripe Prices
// Map bundles → Stripe price IDs
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
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      ui_mode: 'embedded',

      // What the customer is buying
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],

      // 👇 1) Collect full SHIPPING ADDRESS
      shipping_address_collection: {
        // change / add countries if you expand later
        allowed_countries: ['MY'],
      },

      // 👇 2) Show a “3–7 day delivery” shipping method (FREE)
      shipping_options: [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: 0, currency: 'myr' },
            display_name: '3–7 day delivery',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 3 },
              maximum: { unit: 'business_day', value: 7 },
            },
          },
        },
      ],

      // 👇 3) Ask for phone number in Checkout
      phone_number_collection: {
        enabled: true,
      },

      // Use email from your page if present (optional)
      customer_email: customer.email || undefined,

      // Where Stripe sends them back after payment
      return_url:
        'https://buzzblock.shop/thankyou.html?session_id={CHECKOUT_SESSION_ID}',

      // Tracking & extra info you want to see in webhook
      metadata: {
        mgid_clickid: mgidClickId,
        bundle,
        customer_name: customer.name || '',
      },
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
      message: 'Payment configuration error',
    });
  }
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 BuzzBlock server listening on port ${PORT}`);
});
