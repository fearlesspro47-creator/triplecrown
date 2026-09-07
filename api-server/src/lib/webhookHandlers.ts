import { getStripeSync } from "./stripeClient";

export class WebhookHandlers {
  static async processWebhook(
    payload: Buffer,
    signature: string,
  ): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        "Stripe webhook payload must be a Buffer. This usually means " +
          "express.json() parsed the body before the webhook route. Register " +
          "the webhook route BEFORE app.use(express.json()).",
      );
    }

    const sync = await getStripeSync();
    await sync.processWebhook(payload, signature);
  }
}
