import { runMigrations } from "stripe-replit-sync";
import { getStripeSync } from "./stripeClient";
import { logger } from "./logger";

// Non-fatal: membership reads subscription state from the DB, so paying members
// stay unlocked even if this init fails; checkout/portal degrade to 503.
export async function initStripe(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.error("DATABASE_URL missing; skipping Stripe init");
    return;
  }

  try {
    await runMigrations({ databaseUrl });
    logger.info("Stripe schema ready");

    const stripeSync = await getStripeSync();

    const domain = process.env.REPLIT_DOMAINS?.split(",")[0];
    if (domain) {
      const webhookResult = await stripeSync.findOrCreateManagedWebhook(
        `https://${domain}/api/stripe/webhook`,
      );
      logger.info(
        { webhook: webhookResult?.url ?? "configured" },
        "Stripe webhook ready",
      );
    } else {
      logger.warn("REPLIT_DOMAINS unset; skipping managed webhook setup");
    }

    stripeSync
      .syncBackfill()
      .then(() => logger.info("Stripe data synced"))
      .catch((err) => logger.error({ err }, "Stripe backfill error"));
  } catch (err) {
    logger.error(
      { err },
      "Failed to initialize Stripe (membership features degraded)",
    );
  }
}
