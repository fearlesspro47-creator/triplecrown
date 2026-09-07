# Triple Crown AI — external hosting package

This package contains the frontend, API server, shared libraries, database schema, and ML service source for Triple Crown AI.

## Important before hosting elsewhere

This is a full-stack app, not just a static website. It needs:

- A PostgreSQL database
- A Node.js 24 runtime with pnpm
- One public frontend service and one API service, or a reverse proxy that routes `/api/*` to the API
- Clerk environment variables for authentication
- A Stripe account and standard Stripe server credentials/webhook setup; the current Replit-managed Stripe connector does not transfer to another host
- `ML_INGEST_TOKEN` if using the ML ingestion bridge

## Basic build outline

1. Install Node.js 24 and pnpm.
2. Run `pnpm install --frozen-lockfile`.
3. Set the required environment variables before starting services.
4. Apply the database schema with `pnpm --filter @workspace/db run push`.
5. Build the API: `pnpm --filter @workspace/api-server run build`.
6. Start the API with `PORT=8080 pnpm --filter @workspace/api-server run start`.
7. Build the frontend with `BASE_PATH=/ PORT=5173 NODE_ENV=production pnpm --filter @workspace/triple-crown run build`.
8. Serve `artifacts/triple-crown/dist/public` as the frontend and route `/api` to the API service.

The frontend is designed to call the API through the same `/api` path. Do not expose database credentials or secret keys in frontend environment variables.

## Environment variable names

Review the application code and set the appropriate values for your host:

- `DATABASE_URL`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `VITE_CLERK_PUBLISHABLE_KEY`
- `SESSION_SECRET`
- `ML_INGEST_TOKEN`
- `ML_INGEST_URL`
- `ADMIN_EMAILS`
- Standard Stripe credentials and webhook signing secret after replacing the Replit Stripe connector

Never commit real secret values to this package or a public repository.
