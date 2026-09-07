import type { Request, Response, NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { sql, eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { getUncachableStripeClient } from "./stripeClient";

export const MEMBERSHIP_PRODUCT_NAME = "Triple Crown AI Membership";
const ACTIVE_STATUSES = ["active", "trialing"];

// Owner / comp-access allowlist. Any signed-in user whose Clerk email is in
// ADMIN_EMAILS is treated as a member without a Stripe subscription. Keyed by
// EMAIL (not Clerk userId) so the same list works across the separate dev/prod
// Clerk instances, which assign different ids to the same person.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Cache userId -> resolved email so the per-request membership check doesn't hit
// Clerk on every board load. Negative lookups are cached too.
const adminEmailCache = new Map<string, { email: string | null; at: number }>();
const ADMIN_EMAIL_TTL_MS = 10 * 60 * 1000;

async function isAllowlistedAdmin(userId: string): Promise<boolean> {
  if (ADMIN_EMAILS.length === 0) return false;
  let entry = adminEmailCache.get(userId);
  if (!entry || Date.now() - entry.at > ADMIN_EMAIL_TTL_MS) {
    try {
      const user = await clerkClient.users.getUser(userId);
      // Only match a VERIFIED email so nobody can claim the owner's address as an
      // unverified email and get comped access. Prefer the primary if verified,
      // else any verified address on the account.
      const emails = user.emailAddresses ?? [];
      const primary = user.primaryEmailAddress;
      const verified =
        (primary && primary.verification?.status === "verified"
          ? primary
          : null) ??
        emails.find((e) => e.verification?.status === "verified") ??
        null;
      const email = verified?.emailAddress?.toLowerCase() ?? null;
      entry = { email, at: Date.now() };
      adminEmailCache.set(userId, entry);
    } catch {
      return false;
    }
  }
  return entry.email !== null && ADMIN_EMAILS.includes(entry.email);
}

export interface MembershipStatus {
  isMember: boolean;
  status: string | null;
}

export interface MembershipPlan {
  priceId: string;
  unitAmount: number;
  currency: string;
  interval: string;
  productName: string;
}

export function getClerkUserId(req: Request): string | null {
  try {
    return getAuth(req).userId ?? null;
  } catch {
    return null;
  }
}

/**
 * Membership is read from the synced `stripe.subscriptions` table (kept fresh by
 * the managed webhook + boot backfill). A member has a subscription in
 * 'active' or 'trialing'. `past_due` is intentionally NOT a member;
 * cancel-at-period-end stays a member until the period actually ends.
 */
export async function getMembership(req: Request): Promise<MembershipStatus> {
  const userId = getClerkUserId(req);
  if (!userId) return { isMember: false, status: null };

  // Owner / comp-access allowlist: full member without a Stripe subscription.
  if (await isAllowlistedAdmin(userId)) {
    return { isMember: true, status: "complimentary" };
  }

  const [user] = await db
    .select({ customerId: usersTable.stripeCustomerId })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  const customerId = user?.customerId;
  if (!customerId) return { isMember: false, status: null };

  // NOTE: drizzle's sql template expands a JS array into a parenthesized
  // parameter list `($1, $2)` — valid for IN, but NOT for = ANY(), which
  // requires a real Postgres array ("op ANY/ALL (array) requires array on
  // right side"). Using ANY here broke every paying member's unlock in prod.
  const rows = await db.execute(sql`
    SELECT status
    FROM stripe.subscriptions
    WHERE customer = ${customerId}
      AND status IN ${ACTIVE_STATUSES}
    ORDER BY created DESC
    LIMIT 1
  `);
  const row = rows.rows[0] as { status?: string } | undefined;
  if (row?.status) return { isMember: true, status: row.status };
  return { isMember: false, status: null };
}

/** Express gate for hard-locked premium routes. Fails closed (403) on error. */
export async function requireActiveMembership(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { isMember } = await getMembership(req);
    if (!isMember) {
      res.status(403).json({
        error: "membership_required",
        message:
          "This feature requires an active Triple Crown AI membership.",
      });
      return;
    }
    next();
  } catch (err) {
    req.log?.error({ err }, "membership check failed");
    res.status(403).json({ error: "membership_required" });
  }
}

/**
 * Returns the user's Stripe customer id, creating one (and the local user row)
 * on first use. Idempotency key + COALESCE upsert make concurrent calls safe.
 */
export async function getOrCreateStripeCustomer(
  userId: string,
  email: string | null,
): Promise<string> {
  const [existing] = await db
    .select({ customerId: usersTable.stripeCustomerId })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (existing?.customerId) return existing.customerId;

  const stripe = await getUncachableStripeClient();
  const customer = await stripe.customers.create(
    {
      email: email ?? undefined,
      metadata: { clerkUserId: userId },
    },
    { idempotencyKey: `customer-create:${userId}` },
  );

  await db
    .insert(usersTable)
    .values({ id: userId, email, stripeCustomerId: customer.id })
    .onConflictDoUpdate({
      target: usersTable.id,
      set: {
        stripeCustomerId: sql`COALESCE(${usersTable.stripeCustomerId}, ${customer.id})`,
        email: sql`COALESCE(${usersTable.email}, ${email})`,
        updatedAt: new Date(),
      },
    });

  const [after] = await db
    .select({ customerId: usersTable.stripeCustomerId })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return after?.customerId ?? customer.id;
}

let planCache: { plan: MembershipPlan; at: number } | null = null;
const PLAN_TTL_MS = 5 * 60 * 1000;

/**
 * The membership price read LIVE from Stripe. syncBackfill does not mirror the
 * product/price catalog for a product created before the webhook existed, so we
 * never read `stripe.prices` here — we ask Stripe directly (cached 5 min).
 */
export async function getMembershipPrice(): Promise<MembershipPlan> {
  if (planCache && Date.now() - planCache.at < PLAN_TTL_MS) {
    return planCache.plan;
  }

  const stripe = await getUncachableStripeClient();
  const products = await stripe.products.search({
    query: `name:'${MEMBERSHIP_PRODUCT_NAME}' AND active:'true'`,
  });
  const product = products.data[0];
  if (!product) throw new Error("Membership product not found in Stripe");

  const prices = await stripe.prices.list({ product: product.id, active: true });
  const monthly =
    prices.data.find(
      (p) =>
        p.recurring?.interval === "month" &&
        p.unit_amount === 300 &&
        p.currency === "usd",
    ) ?? prices.data.find((p) => p.recurring?.interval === "month");
  if (!monthly) throw new Error("Monthly membership price not found in Stripe");

  const plan: MembershipPlan = {
    priceId: monthly.id,
    unitAmount: monthly.unit_amount ?? 300,
    currency: monthly.currency,
    interval: monthly.recurring?.interval ?? "month",
    productName: product.name,
  };
  planCache = { plan, at: Date.now() };
  return plan;
}
