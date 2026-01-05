// server/server.js
require('dotenv').config({ path: __dirname + '/.env' });

const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

console.log('Loaded STRIPE_SECRET_KEY', !!stripeSecretKey);
console.log('Loaded STRIPE_WEBHOOK_SECRET', !!webhookSecret);

const stripe = Stripe(stripeSecretKey);
const app = express();

// 1) Webhook endpoint – must use raw body
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error('❌ Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // We only care about completed checkouts
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      const mgidClickId = session.metadata?.mgid_clickid || '';
      const bemobClickId = session.metadata?.bemob_clickid || '';
      const bundle = session.metadata?.bundle || '';
      const amountTotal = session.amount_total || 0; // in smallest currency unit (sen)
      const currency = session.currency; // e.g. "myr"

      const payout = amountTotal / 100; // e.g. 148.00

      console.log('✅ checkout.session.completed');
      console.log('  mgidClickId:', mgidClickId);
      console.log('  bemobClickId:', bemobClickId);
      console.log('  bundle:', bundle);
      console.log('  payout:', payout, currency);

      const postbacks = [];

      // MGID S2S
      if (mgidClickId) {
        const mgidUrl =
          'https://a.mgid.com/postback/911140' +
          `?c=${encodeURIComponent(mgidClickId)}` +
          `&e=purchase` +
          `&r=${encodeURIComponent(payout)}`;

        console.log('→ MGID postback:', mgidUrl);

        postbacks.push(
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

      // BeMob S2S
      if (bemobClickId) {
        const bemobUrl =
          'https://9805o.bemobtrcks.com/postback' +
          `?cid=${encodeURIComponent(bemobClickId)}` +
          `&payout=${encodeURIComponent(payout)}`;

        console.log('→ BeMob postback:', bemobUrl);

        postbacks.push(
          fetch(bemobUrl)
            .then((r) => r.text())
            .then((body) => {
              console.log('BeMob response:', body);
            })
            .catch((err) => {
              console.error('BeMob postback error:', err.message);
            })
        );
      }

      await Promise.all(postbacks);
    } else {
      console.log('Ignored event type:', event.type);
    }

    res.json({ received: true });
  }
);

// 2) After webhook: normal middleware
app.use(express.json());
app.use(cors());

// Health-check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Map bundles → Stripe price IDs
const PRICE_MAP = {
  '1': process.env.STRIPE_PRICE_1,
  '2': process.env.STRIPE_PRICE_2,
  '3': process.env.STRIPE_PRICE_3
};

// Create Stripe Checkout Session (embedded)
app.post('/create-session', async (req, res) => {
  console.log('--- /create-session called ---');
  console.log('Body:', req.body);

  const { bundle, tracking, customer } = req.body || {};

  if (!bundle) {
    return res.status(400).json({ error: 'Missing bundle selection' });
  }

  const priceId = PRICE_MAP[bundle];
  if (!priceId) {
    return res
      .status(400)
      .json({ error: 'Invalid bundle or missing STRIPE_PRICE env' });
  }

  const mgidClickId = tracking?.mgid_clickid || '';
  const bemobClickId = tracking?.bemob_clickid || '';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      ui_mode: 'embedded',
      line_items: [
        {
          price: priceId,
          quantity: 1
        }
      ],
      customer_email: customer?.email || undefined,
      return_url:
        'https://buzzblock.shop/thankyou.html?session_id={CHECKOUT_SESSION_ID}',
      metadata: {
        mgid_clickid: mgidClickId,
        bemob_clickid: bemobClickId,
        bundle,
        customer_name: customer?.name || ''
      }
    });

    console.log('✅ Created Session:', session.id);

    res.json({
      clientSecret: session.client_secret,
      sessionId: session.id
    });
  } catch (err) {
    console.error('❌ Stripe error:', err);
    res.status(500).json({
      error: 'Stripe error',
      message: 'Payment configuration error (test env)'
    });
  }
});

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 BuzzBlock server listening on port ${PORT}`);
});
