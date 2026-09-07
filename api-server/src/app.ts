import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import router from "./routes";
import { logger } from "./lib/logger";
import { WebhookHandlers } from "./lib/webhookHandlers";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Clerk auth proxy — must be mounted before the body parsers because it streams
// raw bytes through to Clerk's Frontend API in production. No-ops in dev.
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

// Stripe webhook needs the raw request body, so it must be registered BEFORE
// the JSON body parser. It is a server-to-server call (no CORS/Clerk).
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];
    if (!signature) {
      res.status(400).json({ error: "Missing stripe-signature" });
      return;
    }

    try {
      const sig = Array.isArray(signature) ? signature[0] : signature;
      if (!Buffer.isBuffer(req.body)) {
        req.log.error(
          "Stripe webhook body is not a Buffer; express.json() ran before the webhook route",
        );
        res.status(500).json({ error: "Webhook processing error" });
        return;
      }

      await WebhookHandlers.processWebhook(req.body, sig);
      res.status(200).json({ received: true });
    } catch (error) {
      req.log.error({ err: error }, "Stripe webhook error");
      res.status(400).json({ error: "Webhook processing error" });
    }
  },
);

// Now that auth-gated, per-user routes exist (membership/checkout), we no longer
// reflect any origin. Allow only this deployment's own domains (same-origin via
// the proxy) with credentials; requests without an Origin header (curl,
// server-to-server, same-origin navigations) are allowed through.
const allowedOrigins = new Set(
  [
    ...(process.env.REPLIT_DOMAINS ?? "").split(","),
    process.env.REPLIT_DEV_DOMAIN ?? "",
  ]
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => `https://${d}`),
);
app.use(
  cors({
    credentials: true,
    origin(origin, cb) {
      if (!origin || allowedOrigins.has(origin)) return cb(null, true);
      return cb(null, false);
    },
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Resolve the publishable key from the incoming request host so the same server
// can serve multiple Clerk custom domains. Falls back to CLERK_PUBLISHABLE_KEY
// when the host doesn't map to a custom domain.
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use("/api", router);

export default app;
