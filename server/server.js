// server/server.js
require('dotenv').config({ path: __dirname + '/.env' });

const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');

// ---- env ----
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

// GA4 Measurement Protocol (optional)
const gaMeasurementId = process.env.GA4_MEASUREMENT_ID || ''; // must be G-XXXXXXXXXX
const gaApiSecret = process.env.GA4_API_SECRET || '';

// MGID postback id (your 911140)
const mgidPostbackId = process.env.MGID_POSTBACK_ID || '911140';

if (!stripeSecretKey) {
  console.error('FATAL: STRIPE_SECRET_KEY env var is missing');
  process.exit(1);
}

console.log('Loaded STRIPE_SECRET_KEY:', true);
console.log('Loaded STRIPE_WEBHOOK_SECRET:', !!webhookSecret);
console.log('Loaded GA4_MEASUREMENT_ID:', gaMeasurementId || '(missing)');
console.log('Loaded GA4_API_SECRET:', !!gaApiSecret);
console.log('Loaded MGID_POSTBACK_ID:', mgidPostbackId);

const stripe = Stripe(stripeSecretKey);
const app = express();

// ---- fetch fallback (Render usually has Node18+ so global fetch exists, but just in case) ----
const fetchFn =
  global.fetch ||
  ((...args) =>
    import('node-fetch').then(({ default: fetch }) => fetch(...args)));

// ──────────────────────────────────────────────
// MGID in-memory dedupe (no Redis)
// ──────────────────────────────────────────────
/** @type {Map<string, number>} */
const mgidDedupe = new Map();

function dedupeHit(key) {
  const now = Date.now();
  const exp = mgidDedupe.get(key);
  return exp !== undefined && exp > now;
}

function dedupeMark(key, ttlMs) {
  mgidDedupe.set(key, Date.now() + ttlMs);
}

// cleanup
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of mgidDedupe.entries()) {
    if (exp <= now) mgidDedupe.delete(k);
  }
}, 60_000).unref();


// ──────────────────────────────────────────────
// OPTION 2: MGID revenue signal per bundle
// (NOT real MYR; use to tell MGID which bundle is "better")
// ──────────────────────────────────────────────
const MGID_REVENUE_SIGNAL_MAP = {
  '1': 1.0,
  '2': 1.9,
  '3': 2.7,
  '4': 3.4,
  '5': 4.0,
};

// ──────────────────────────────────────────────
// GA4 Measurement Protocol purchase event (optional)
// ──────────────────────────────────────────────
async function sendGa4Purchase({
  mgidClickId,
  bundle,
  payout,
  currency,
  mgidSourceId,
  mgidSiteId,
  mgidTeaserId,
  mgidSource,
  mgidCampaignId,
  transactionId,
}) {
  if (!gaMeasurementId || !gaApiSecret) {
    console.log('GA4 MP not configured (missing GA4_MEASUREMENT_ID or GA4_API_SECRET), skipping');
    return;
  }

  const url =
    `https://www.google-analytics.com/mp/collect` +
    `?measurement_id=${encodeURIComponent(gaMeasurementId)}` +
    `&api_secret=${encodeURIComponent(gaApiSecret)}`;

  // GA4 MP requires *some* client_id. We'll reuse click id if present.
  const clientId = mgidClickId || `srv-${Date.now()}`;

  const body = {
    client_id: clientId,
    events: [
      {
        name: 'purchase',
        params: {
          transaction_id: transactionId || undefined,
          value: payout,
          currency,

          // These only become reportable if you register them as custom dimensions in GA4
          mgid_clickid: mgidClickId || undefined,
          mgid_source_id: mgidSourceId || undefined,
          mgid_site_id: mgidSiteId || undefined,
          mgid_teaser_id: mgidTeaserId || undefined,
          mgid_source: mgidSource || undefined,
          mgid_campaign_id: mgidCampaignId || undefined,

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
    const resp = await fetchFn(url, {
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

// ──────────────────────────────────────────────
// MGID S2S postback (generic)
// IMPORTANT: r= is our "revenueSignal" (Option 2), not real MYR.
// ──────────────────────────────────────────────
async function sendMgidPostbackEvent({
  mgidClickId,
  eventName,
  revenueSignal,
}) {
  if (!mgidClickId) {
    console.log('MGID: no click id, skipping postback');
    return;
  }
  if (!eventName) {
    console.log('MGID: no event name, skipping postback');
    return;
  }

  const base =
    `https://a.mgid.com/postback/${encodeURIComponent(mgidPostbackId)}` +
    `?c=${encodeURIComponent(mgidClickId)}` +
    `&e=${encodeURIComponent(eventName)}`;

  // MGID postback UI includes r=, but for click-goals it's fine to send r=0 or omit.
  const url =
    revenueSignal === undefined || revenueSignal === null
      ? `${base}&r=0`
      : `${base}&r=${encodeURIComponent(String(revenueSignal))}`;

  console.log('→ MGID postback:', url);

  try {
    const r = await fetchFn(url);
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
    // Paid-only trigger
    if (event.type === 'payment_intent.succeeded') {
      // IMPORTANT:
      // "Resend" replays the OLD event payload -> metadata in event can be stale.
      // Fetch PI fresh from Stripe to read latest metadata + dedupe flag.
      const piId = event.data.object?.id;
      if (!piId) {
        console.warn('payment_intent.succeeded missing PI id');
        return res.json({ received: true });
      }

      const pi = await stripe.paymentIntents.retrieve(piId);

      const mgidClickId = pi.metadata?.mgid_clickid || '';
      const bundle = pi.metadata?.bundle || '';
      const mgidSourceId = pi.metadata?.source_id || '';
      const mgidSiteId = pi.metadata?.site_id || '';
      const mgidTeaserId = pi.metadata?.teaser_id || '';
      const mgidSource = pi.metadata?.source || '';
      const mgidCampaignId = pi.metadata?.campaign_id || '';

      const currency = (pi.currency || 'myr').toLowerCase();
      const amount =
        typeof pi.amount_received === 'number' ? pi.amount_received : pi.amount;
      const payoutReal = (amount || 0) / 100;

      const alreadySent = pi.metadata?.mgid_postback_sent === '1';
      const revenueSignal = MGID_REVENUE_SIGNAL_MAP[bundle] ?? 1.0;

      console.log('✅ payment_intent.succeeded');
      console.log('  pi:', pi.id);
      console.log('  mgidClickId:', mgidClickId);
      console.log('  bundle:', bundle);
      console.log('  payoutReal:', payoutReal, currency);
      console.log('  mgid_revenue_signal:', revenueSignal);
      console.log('  mgid_postback_sent (fresh):', alreadySent);

      if (!alreadySent) {
        await Promise.all([
          sendMgidPostbackEvent({
            mgidClickId,
            eventName: 'purchase',
            revenueSignal,
          }),
          // GA4 gets REAL payout (not the MGID signal)
          sendGa4Purchase({
            mgidClickId,
            bundle,
            payout: payoutReal,
            currency,
            mgidSourceId,
            mgidSiteId,
            mgidTeaserId,
            mgidSource,
            mgidCampaignId,
            transactionId: pi.id,
          }),
        ]);

        // Persist "sent" flag in Stripe to avoid duplicates
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
    } else {
      // Keep logs minimal, but helpful
      console.log('Ignored event type:', event.type);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('❌ Webhook handler error:', err);
    return res.status(500).send('Webhook handler error');
  }
});

// ──────────────────────────────────────────────
// ──────────────────────────────────────────────
// ──────────────────────────────────────────────
// ──────────────────────────────────────────────
// 2) Normal middleware (AFTER webhook)
// ──────────────────────────────────────────────
app.use(express.json());

// CORS must be enabled for ALL browser->backend calls (Stripe embedded checkout relies on this)
const ALLOWED_ORIGINS = new Set([
  "https://buzzblock.shop",
  "https://modernworldnews.info",
]);

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no Origin (server-to-server, Stripe webhooks, curl, etc.)
    if (!origin) return callback(null, true);

    // Allow only your sites in the browser
    if (ALLOWED_ORIGINS.has(origin)) return callback(null, true);

    return callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
};

app.use(cors(corsOptions));

// Explicitly handle preflight for all routes (including /create-session and /mgid-goal/*)
app.options("*", cors(corsOptions));

// Health-check
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Base URL so Render URL doesn't look "broken"
app.get('/', (_req, res) => {
  res.status(200).send('ok');
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
    return res.status(400).json({
      error: 'Invalid bundle or missing STRIPE_PRICE env',
    });
  }

  const mgidClickId = tracking.mgid_clickid || '';
  const mgidSourceId = tracking.source_id || '';
  const mgidSiteId = tracking.site_id || '';
  const mgidTeaserId = tracking.teaser_id || '';
  const mgidSource = tracking.source || '';
  const mgidCampaignId = tracking.campaign_id || '';

  try {
    // Shipping: bundle 1 has RM 9.99, others free
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

      line_items: [{ price: priceId, quantity: 1 }],

      shipping_address_collection: { allowed_countries: ['MY'] },
      shipping_options: shippingOptions,

      phone_number_collection: { enabled: true },

      customer_email: customer.email || undefined,

      // session metadata (debug)
      metadata: {
        mgid_clickid: mgidClickId,
        source_id: mgidSourceId,
        site_id: mgidSiteId,
        teaser_id: mgidTeaserId,
        source: mgidSource,
        campaign_id: mgidCampaignId,
        bundle,
        customer_name: customer.name || '',
      },

      // payment_intent metadata (what we actually use in payment_intent.succeeded)
      payment_intent_data: {
        metadata: {
          mgid_clickid: mgidClickId,
          source_id: mgidSourceId,
          site_id: mgidSiteId,
          teaser_id: mgidTeaserId,
          source: mgidSource,
          campaign_id: mgidCampaignId,
          bundle,
          customer_name: customer.name || '',
          mgid_postback_sent: '0',
        },
      },

      return_url:
        'https://buzzblock.shop/thankyou.html?session_id={CHECKOUT_SESSION_ID}',
    });

    console.log('✅ Created Session:', session.id);

    return res.json({
      clientSecret: session.client_secret,
      sessionId: session.id,
    });
  } catch (err) {
    console.error('❌ Stripe error in /create-session:', err);
    return res.status(500).json({
      error: 'Stripe error',
      message: err && err.message ? err.message : 'Payment configuration error',
    });
  }
});


// ──────────────────────────────────────────────
// MGID additional goals (LP→PP and PP→Checkout)
// ──────────────────────────────────────────────
function extractMgidClickId(req) {
  // Accept multiple shapes to make frontend changes painless
  return (
    req.body?.mgid_clickid ||
    req.body?.tracking?.mgid_clickid ||
    req.body?.c ||
    req.query?.mgid_clickid ||
    req.query?.c ||
    ''
  );
}

async function handleGoal(req, res, eventName) {
  const mgidClickId = extractMgidClickId(req);

  // ✅ TRUTH TEST LOG #1: did we get hit + what clickid did we extract?
  console.log(
    "[MGID GOAL HIT]",
    "event=", eventName,
    "clickid=", mgidClickId || "(missing)",
    "origin=", req.headers.origin || "(none)"
  );

  if (!mgidClickId) {
    console.log("[MGID GOAL REJECTED] Missing mgid_clickid");
    return res.status(400).json({ error: "Missing mgid_clickid" });
  }

  const key = `${mgidClickId}:${eventName}`;

  if (dedupeHit(key)) {
    console.log("[MGID GOAL DEDUPED]", key);
    return res.json({ ok: true, deduped: true });
  }

  // 7 days TTL is safe
  dedupeMark(key, 7 * 24 * 60 * 60 * 1000);

  // ✅ TRUTH TEST LOG #2: we are about to send MGID postback
  console.log("[MGID POSTBACK SENDING]", eventName, mgidClickId);

  try {
    await sendMgidPostbackEvent({
      mgidClickId,
      eventName,
      revenueSignal: 0,
    });

    // ✅ TRUTH TEST LOG #3: postback call finished without throwing
    console.log("[MGID POSTBACK SENT]", eventName, mgidClickId);
  } catch (err) {
    // ✅ TRUTH TEST LOG #4: MGID postback failed
    console.error("[MGID POSTBACK FAILED]", eventName, mgidClickId, err);
    // optional: you can return 500 here if you want MGID failures visible
    // return res.status(500).json({ error: "MGID postback failed" });
  }

  return res.json({ ok: true });
}

app.post('/mgid-goal/lp_to_pp', async (req, res) => {
  try {
    return await handleGoal(req, res, 'lp_to_pp');
  } catch (e) {
    console.error('lp_to_pp error:', e);
    return res.status(500).json({ error: 'server error' });
  }
});

app.post('/mgid-goal/pp_to_checkout', async (req, res) => {
  try {
    return await handleGoal(req, res, 'pp_to_checkout');
  } catch (e) {
    console.error('pp_to_checkout error:', e);
    return res.status(500).json({ error: 'server error' });
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
