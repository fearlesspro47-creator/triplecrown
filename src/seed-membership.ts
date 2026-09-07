import { getUncachableStripeClient } from "./stripeClient";

const PRODUCT_NAME = "Triple Crown AI Membership";
const MONTHLY_AMOUNT = 300;
const CURRENCY = "usd";

async function seed() {
  const stripe = await getUncachableStripeClient();

  const existing = await stripe.products.search({
    query: `name:'${PRODUCT_NAME}' AND active:'true'`,
  });

  let product = existing.data[0];
  if (product) {
    console.log(`Product already exists: ${product.name} (${product.id})`);
  } else {
    product = await stripe.products.create({
      name: PRODUCT_NAME,
      description:
        "Unlock Crown Scores, AI Top Picks with reasoning, the Lineup Optimizer, matchup insights & pitch-mix tables, Odds and Compare.",
    });
    console.log(`Created product: ${product.name} (${product.id})`);
  }

  const prices = await stripe.prices.list({ product: product.id, active: true });
  const monthly = prices.data.find(
    (p) =>
      p.recurring?.interval === "month" &&
      p.unit_amount === MONTHLY_AMOUNT &&
      p.currency === CURRENCY,
  );

  if (monthly) {
    console.log(`Monthly price already exists: ${monthly.id}`);
  } else {
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: MONTHLY_AMOUNT,
      currency: CURRENCY,
      recurring: { interval: "month" },
    });
    console.log(`Created monthly price: $3.00/month (${price.id})`);
  }

  console.log("Done. Webhook sync will mirror this into the stripe schema.");
}

seed().catch((err) => {
  console.error("Error seeding membership product:", err);
  process.exit(1);
});
