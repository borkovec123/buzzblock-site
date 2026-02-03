// server/server.js
require("dotenv").config({ path: __dirname + "/.env" });

const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

// ---- env ----
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";

// GA4 Measurement Protocol (optional but you want it)
const gaMeasurementId = process.env.GA4_MEASUREMENT_ID || ""; // G-XXXXXXXXXX
const gaApiSecret = process.env.GA4_API_SECRET || "";

// MGID postback id (your 911140)
const mgidPostbackId = process.env.MGID_POSTBACK_ID || "911140";

if (!stripeSecretKey) {
  console.error("FATAL: STRIPE_SECRET_KEY env var is missing");
  process.exit(1);
}

console.log("Loaded STRIPE_SECRET_KEY:", true);
console.log("Loaded STRIPE_WEBHOOK_SECRET:", !!webhookSecret);
console.log("Loaded GA4_MEASUREMENT_ID:", gaMeasurementId || "(missing)");
console.log("Loaded GA4_API_SECRET:", !!gaApiSecret);
console.log("Loaded MGID_POSTBACK_ID:", mgidPostbackId);

const stripe = Stripe(stripeSecretKey);
const app = express();

// ---- fetch fallback (Render Node18+ usually has global fetch) ----
const fetchFn =
  global.fetch ||
  ((...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args)));

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
// MGID revenue signal per bundle (NOT real MYR)
// ──────────────────────────────────────────────
const MGID_REVENUE_SIGNAL_MAP = {
  "1": 1.0,
  "2": 1.9,
  "3": 2.7,
  "4": 3.4,
  "5": 4.0,
};

// ──────────────────────────────────────────────
// GA4 Measurement Protocol purchase event
// IMPORTANT: use REAL ga_client_id from browser if available
// and send SAME param names as your GTM events (source_id, teaser_id, etc.)
// ──────────────────────────────────────────────
async function sendGa4Purchase({
  gaClientId,
  mgidClickId,
  bundle,
  payout,
  currency,
  sourceId,
  siteId,
  teaserId,
  widgetId,
  source,
  campaignId,
  transactionId,
}) {
  if (!gaMeasurementId || !gaApiSecret) {
    console.log(
      "GA4 MP not configured (missing GA4_MEASUREMENT_ID or GA4_API_SECRET), skipping"
    );
    return;
  }

  const GA4_DEBUG = true; // <-- set to false after test

const base = GA4_DEBUG
  ? "https://www.google-analytics.com/debug/mp/collect"
  : "https://www.google-analytics.com/mp/collect";

const url =
  `${base}?measurement_id=${encodeURIComponent(gaMeasurementId)}` +
  `&api_secret=${encodeURIComponent(gaApiSecret)}`;

  // ✅ This is the key to being able to break down purchase by teaser_id, etc.
  // Use the real GA4 client_id from the browser (_ga cookie), passed via checkout -> server -> PI metadata
  const clientId = gaClientId || mgidClickId || `srv-${Date.now()}`;

  const body = {
    client_id: clientId,
    // helpful to avoid GA4 dropping event for missing engagement
    events: [
      {
        name: "purchase",
        params: {
          // GA4 recommended fields
          transaction_id: transactionId || undefined,
          value: payout,
          currency: currency || "myr",
          engagement_time_msec: 1,

          // ✅ Your MGID dimensions (use SAME names as your other events)
          mgid_clickid: mgidClickId || undefined,
          source_id: sourceId || undefined,
          site_id: siteId || undefined,
          teaser_id: teaserId || undefined,
          widget_id: widgetId || undefined,
          source: source || undefined,
          campaign_id: campaignId || undefined,

          // items array makes GA4 treat it as ecommerce cleanly
          items: [
            {
              item_name: "BuzzBlock",
              quantity: Number(bundle) || 1,
            },
          ],
        },
      },
    ],
  };

  try {
    const resp = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
console.log("GA4 MP status:", resp.status);
console.log("GA4 MP body:", text);
  } catch (err) {
    console.error("GA4 MP error:", err?.message || err);
  }
}

// ──────────────────────────────────────────────
// MGID S2S postback (generic)
// ──────────────────────────────────────────────
async function sendMgidPostbackEvent({ mgidClickId, eventName, revenueSignal }) {
  if (!mgidClickId) {
    console.log("MGID: no click id, skipping postback");
    return;
  }
  if (!eventName) {
    console.log("MGID: no event name, skipping postback");
    return;
  }

  const base =
    `https://a.mgid.com/postback/${encodeURIComponent(mgidPostbackId)}` +
    `?c=${encodeURIComponent(mgidClickId)}` +
    `&e=${encodeURIComponent(eventName)}`;

  const url =
    revenueSignal === undefined || revenueSignal === null
      ? `${base}&r=0`
      : `${base}&r=${encodeURIComponent(String(revenueSignal))}`;

  console.log("→ MGID postback:", url);

  try {
    const r = await fetchFn(url);
    const body = await r.text();
    console.log("MGID response status:", r.status);
    console.log("MGID response body:", body);
  } catch (err) {
    console.error("MGID postback error:", err?.message || err);
  }
}

// ──────────────────────────────────────────────
// 1) Webhook endpoint – MUST be raw body
// ──────────────────────────────────────────────
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;
    try {
      if (!webhookSecret) {
        console.warn("⚠️ STRIPE_WEBHOOK_SECRET is not set – rejecting webhook.");
        return res.status(400).send("Webhook secret not configured");
      }
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error("❌ Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      if (event.type === "payment_intent.succeeded") {
        const piId = event.data.object?.id;
        if (!piId) {
          console.warn("payment_intent.succeeded missing PI id");
          return res.json({ received: true });
        }

        // Fetch fresh PI to avoid stale metadata on webhook retries
        const pi = await stripe.paymentIntents.retrieve(piId);

        const mgidClickId = pi.metadata?.mgid_clickid || "";
        const bundle = pi.metadata?.bundle || "";

        const sourceId = pi.metadata?.source_id || "";
        const siteId = pi.metadata?.site_id || "";
        const teaserId = pi.metadata?.teaser_id || "";
        const widgetId = pi.metadata?.widget_id || "";
        const source = pi.metadata?.source || "";
        const campaignId = pi.metadata?.campaign_id || "";

        // ✅ critical for GA4 attribution
        const gaClientId = pi.metadata?.ga_client_id || "";

        const currency = (pi.currency || "myr").toLowerCase();
        const amount =
          typeof pi.amount_received === "number" ? pi.amount_received : pi.amount;
        const payoutReal = (amount || 0) / 100;

        const alreadySent = pi.metadata?.mgid_postback_sent === "1";
        const revenueSignal = MGID_REVENUE_SIGNAL_MAP[bundle] ?? 1.0;

        console.log("✅ payment_intent.succeeded");
        console.log("  pi:", pi.id);
        console.log("  mgidClickId:", mgidClickId);
        console.log("  bundle:", bundle);
        console.log("  payoutReal:", payoutReal, currency);
        console.log("  ga_client_id:", gaClientId || "(missing)");
        console.log("  mgid_postback_sent (fresh):", alreadySent);

        if (!alreadySent) {
          await Promise.all([
            sendMgidPostbackEvent({
              mgidClickId,
              eventName: "purchase",
              revenueSignal,
            }),
            sendGa4Purchase({
              gaClientId,
              mgidClickId,
              bundle,
              payout: payoutReal,
              currency,
              sourceId,
              siteId,
              teaserId,
              widgetId,
              source,
              campaignId,
              transactionId: pi.id,
            }),
          ]);

          // Persist flag in Stripe to avoid duplicates
          try {
            await stripe.paymentIntents.update(pi.id, {
              metadata: {
                ...pi.metadata,
                mgid_postback_sent: "1",
              },
            });
            console.log("✅ Marked PI metadata mgid_postback_sent=1");
          } catch (e) {
            console.error("⚠️ Could not update PI metadata:", e?.message || e);
          }
        } else {
          console.log("↩️ Skipping MGID/GA4: already sent for this PaymentIntent");
        }
      } else {
        console.log("Ignored event type:", event.type);
      }

      return res.json({ received: true });
    } catch (err) {
      console.error("❌ Webhook handler error:", err);
      return res.status(500).send("Webhook handler error");
    }
  }
);

// ──────────────────────────────────────────────
// 2) Normal middleware (AFTER webhook)
// ──────────────────────────────────────────────
app.use(express.json());

app.use(
  cors({
    origin: ["https://buzzblock.shop", "https://modernworldnews.info"],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

// Health-check
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// Base URL so Render URL doesn't look "broken"
app.get("/", (_req, res) => {
  res.status(200).send("ok");
});

// Stripe Prices: Map bundles → Stripe price IDs
const PRICE_MAP = {
  "1": process.env.STRIPE_PRICE_1,
  "2": process.env.STRIPE_PRICE_2,
  "3": process.env.STRIPE_PRICE_3,
  "4": process.env.STRIPE_PRICE_4,
  "5": process.env.STRIPE_PRICE_5,
};

console.log("PRICE_MAP presence:", {
  "1": !!PRICE_MAP["1"],
  "2": !!PRICE_MAP["2"],
  "3": !!PRICE_MAP["3"],
  "4": !!PRICE_MAP["4"],
  "5": !!PRICE_MAP["5"],
});

app.post("/create-session", async (req, res) => {
  console.log("--- /create-session called ---");
  console.log("Body:", req.body);

  const { bundle, tracking = {}, customer = {} } = req.body || {};

  if (!bundle) {
    return res.status(400).json({ error: "Missing bundle selection" });
  }

  const priceId = PRICE_MAP[bundle];
  if (!priceId) {
    return res.status(400).json({
      error: "Invalid bundle or missing STRIPE_PRICE env",
    });
  }

  // tracking passed from checkout.html
  const mgidClickId = tracking.mgid_clickid || "";
  const sourceId = tracking.source_id || "";
  const siteId = tracking.site_id || "";
  const teaserId = tracking.teaser_id || "";
  const widgetId = tracking.widget_id || "";
  const source = tracking.source || "";
  const campaignId = tracking.campaign_id || "";

  // ✅ GA client_id from browser (_ga cookie parsed client-side)
  const gaClientId = tracking.ga_client_id || "";

  try {
    const shippingOptions =
      bundle === "1"
        ? [
            {
              shipping_rate_data: {
                type: "fixed_amount",
                fixed_amount: { amount: 999, currency: "myr" }, // RM 9.99
                display_name: "Shipping (3–7 day delivery)",
                delivery_estimate: {
                  minimum: { unit: "business_day", value: 3 },
                  maximum: { unit: "business_day", value: 7 },
                },
              },
            },
          ]
        : [
            {
              shipping_rate_data: {
                type: "fixed_amount",
                fixed_amount: { amount: 0, currency: "myr" },
                display_name: "FREE Shipping (3–7 day delivery)",
                delivery_estimate: {
                  minimum: { unit: "business_day", value: 3 },
                  maximum: { unit: "business_day", value: 7 },
                },
              },
            },
          ];

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      ui_mode: "embedded",

      line_items: [{ price: priceId, quantity: 1 }],

      shipping_address_collection: { allowed_countries: ["MY"] },
      shipping_options: shippingOptions,

      phone_number_collection: { enabled: true },

      customer_email: customer.email || undefined,

      // session metadata (debug)
      metadata: {
        mgid_clickid: mgidClickId,
        source_id: sourceId,
        site_id: siteId,
        teaser_id: teaserId,
        widget_id: widgetId,
        source,
        campaign_id: campaignId,
        ga_client_id: gaClientId,
        bundle,
        customer_name: customer.name || "",
      },

      // payment_intent metadata (used in webhook)
      payment_intent_data: {
        metadata: {
          mgid_clickid: mgidClickId,
          source_id: sourceId,
          site_id: siteId,
          teaser_id: teaserId,
          widget_id: widgetId,
          source,
          campaign_id: campaignId,
          ga_client_id: gaClientId,
          bundle,
          customer_name: customer.name || "",
          mgid_postback_sent: "0",
        },
      },

      return_url:
        "https://buzzblock.shop/thankyou.html?session_id={CHECKOUT_SESSION_ID}",
    });

    console.log("✅ Created Session:", session.id);

    return res.json({
      clientSecret: session.client_secret,
      sessionId: session.id,
    });
  } catch (err) {
    console.error("❌ Stripe error in /create-session:", err);
    return res.status(500).json({
      error: "Stripe error",
      message: err && err.message ? err.message : "Payment configuration error",
    });
  }
});

// ──────────────────────────────────────────────
// MGID additional goals (LP→PP and PP→Checkout)
// ──────────────────────────────────────────────
function extractMgidClickId(req) {
  return (
    req.body?.mgid_clickid ||
    req.body?.tracking?.mgid_clickid ||
    req.body?.c ||
    req.query?.mgid_clickid ||
    req.query?.c ||
    ""
  );
}

async function handleGoal(req, res, eventName) {
  const mgidClickId = extractMgidClickId(req);

  console.log(
    "[MGID GOAL HIT]",
    "event=",
    eventName,
    "clickid=",
    mgidClickId || "(missing)",
    "origin=",
    req.headers.origin || "(none)"
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

  dedupeMark(key, 7 * 24 * 60 * 60 * 1000);

  console.log("[MGID POSTBACK SENDING]", eventName, mgidClickId);

  try {
    await sendMgidPostbackEvent({
      mgidClickId,
      eventName,
      revenueSignal: 0,
    });
    console.log("[MGID POSTBACK SENT]", eventName, mgidClickId);
  } catch (err) {
    console.error("[MGID POSTBACK FAILED]", eventName, mgidClickId, err);
  }

  return res.json({ ok: true });
}

app.post("/mgid-goal/lp_to_pp", async (req, res) => {
  try {
    return await handleGoal(req, res, "lp_to_pp");
  } catch (e) {
    console.error("lp_to_pp error:", e);
    return res.status(500).json({ error: "server error" });
  }
});

app.post("/mgid-goal/pp_to_checkout", async (req, res) => {
  try {
    return await handleGoal(req, res, "pp_to_checkout");
  } catch (e) {
    console.error("pp_to_checkout error:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// 404
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 BuzzBlock server listening on port ${PORT}`);
});
