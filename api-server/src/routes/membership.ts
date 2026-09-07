import { Router, type Request } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { sql, eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { getUncachableStripeClient, getStripeSync } from "../lib/stripeClient";
import {
  getMembership,
  getMembershipPrice,
  getOrCreateStripeCustomer,
} from "../lib/membership";

const router = Router();

/** The user-facing origin (proxy domain), never the internal service port. */
function getAppOrigin(req: Request): string {
  const domain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (domain) return `https://${domain}`;
  const proto =
    (req.headers["x-forwarded-proto"] as string)?.split(",")[0] || req.protocol;
  const host = (req.headers["x-forwarded-host"] as string) || req.get("host");
  return `${proto}://${host}`;
}

// GET /membership/status
router.get("/status", async (req, res) => {
  try {
    const status = await getMembership(req);
    res.json(status);
  } catch (err) {
    req.log.error({ err }, "membership status failed");
    res.json({ isMember: false, status: null });
  }
});

// GET /membership/plan
router.get("/plan", async (req, res) => {
  try {
    const plan = await getMembershipPrice();
    res.json(plan);
  } catch (err) {
    req.log.error({ err }, "membership plan failed");
    res.status(503).json({ error: "plan_unavailable" });
  }
});

// POST /membership/checkout
router.post("/checkout", async (req, res) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    let email: string | null = null;
    try {
      const user = await clerkClient.users.getUser(userId);
      email =
        user.primaryEmailAddress?.emailAddress ??
        user.emailAddresses[0]?.emailAddress ??
        null;
    } catch {
      // Non-fatal: Checkout collects the email if we don't have it.
    }

    const customerId = await getOrCreateStripeCustomer(userId, email);
    const plan = await getMembershipPrice();
    const stripe = await getUncachableStripeClient();
    const origin = getAppOrigin(req);

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      client_reference_id: userId,
      line_items: [{ price: plan.priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/checkout/cancel`,
    });

    res.json({ url: session.url });
  } catch (err) {
    req.log.error({ err }, "checkout failed");
    res.status(503).json({ error: "checkout_unavailable" });
  }
});

// POST /membership/checkout-confirm  — retrieves the session live so membership
// unlocks immediately without waiting for the webhook to land.
router.post("/checkout-confirm", async (req, res) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const sessionId = req.body?.sessionId;
    if (!sessionId || typeof sessionId !== "string") {
      res.status(400).json({ error: "missing_session_id" });
      return;
    }

    const stripe = await getUncachableStripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription"],
    });

    // The session must belong to the authenticated user.
    if (session.client_reference_id !== userId) {
      res.status(403).json({ error: "session_mismatch" });
      return;
    }

    const customerId =
      typeof session.customer === "string"
        ? session.customer
        : (session.customer?.id ?? null);
    if (customerId) {
      await db
        .insert(usersTable)
        .values({ id: userId, stripeCustomerId: customerId })
        .onConflictDoUpdate({
          target: usersTable.id,
          set: { stripeCustomerId: customerId, updatedAt: new Date() },
        });
    }

    const sub = session.subscription;
    let status: string | null = null;
    let isMember = false;
    if (sub && typeof sub !== "string") {
      status = sub.status;
      isMember = ["active", "trialing"].includes(sub.status);
    }

    // Land the subscription in the local sync tables now so getMembership (which
    // reads stripe.subscriptions) reflects the unlock immediately. Otherwise the
    // client would flash locked UI until the async webhook lands — and in dev the
    // managed webhook is skipped entirely, so membership would stay locked until
    // the next boot backfill. Non-fatal: the response still reports isMember from
    // the live session, and the webhook/next backfill reconciles on failure.
    if (isMember) {
      try {
        const sync = await getStripeSync();
        await sync.syncSubscriptions({ backfillRelatedEntities: true });
      } catch (syncErr) {
        req.log.warn(
          { err: syncErr },
          "post-checkout subscription sync failed (webhook will reconcile)",
        );
      }
    }

    res.json({ isMember, status });
  } catch (err) {
    req.log.error({ err }, "checkout-confirm failed");
    res.status(503).json({ error: "confirm_failed" });
  }
});

// POST /membership/portal — Stripe billing portal (manage/cancel).
router.post("/portal", async (req, res) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const [user] = await db
      .select({ customerId: usersTable.stripeCustomerId })
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    if (!user?.customerId) {
      res.status(404).json({ error: "no_customer" });
      return;
    }

    const stripe = await getUncachableStripeClient();
    const origin = getAppOrigin(req);
    const session = await stripe.billingPortal.sessions.create({
      customer: user.customerId,
      return_url: `${origin}/membership`,
    });
    res.json({ url: session.url });
  } catch (err) {
    req.log.error({ err }, "portal failed");
    res.status(503).json({ error: "portal_unavailable" });
  }
});

export default router;
