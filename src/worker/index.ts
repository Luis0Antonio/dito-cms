import { Hono } from "hono";

import { type AppEnv, baseMiddleware, getAuth } from "./lib/app";
import { toErrorBody } from "./lib/errors";
import { requireAuth } from "./middleware/require-auth";
import { systemRouter } from "./routes/system";
import { adminRouter } from "./routes/admin";
import { deliveryRouter } from "./routes/delivery";
import { commerceRouter } from "./routes/commerce";
import { mediaServeRouter } from "./routes/media";
import { handleMcpRequest } from "./mcp/server";

const app = new Hono<AppEnv>();

app.use("*", baseMiddleware);

// Better Auth owns /api/auth/* (sign-in/up/out, session, admin + apiKey plugin routes).
app.all("/api/auth/*", async (c) => {
  const auth = await getAuth(c);
  return auth.handler(c.req.raw);
});

app.route("/api", systemRouter);
app.route("/api/admin", adminRouter);
app.route("/api/v1", deliveryRouter);
app.route("/api/commerce", commerceRouter);
app.route("/media", mediaServeRouter);

// Stateless MCP server. Bearer API key required (requireAuth, on POST only so an
// unauthenticated GET/DELETE still gets the method guard). GET/DELETE → 405.
app.post("/mcp", requireAuth, (c) => handleMcpRequest(c));
app.on(["GET", "DELETE"], "/mcp", (c) => {
  c.header("Allow", "POST");
  return c.json({ error: { code: "bad_request", message: "The MCP endpoint accepts POST only" } }, 405);
});

// The worker only runs first for /api/*, /media/*, /mcp (run_worker_first). Anything
// unmatched there is a real miss → JSON envelope, never the SPA HTML fallback.
app.notFound((c) =>
  c.json({ error: { code: "not_found", message: "Not found" } }, 404),
);

app.onError((err, c) => {
  const { status, body } = toErrorBody(err);
  if (status === 500) console.error("Unhandled error:", err);
  return c.json(body, status);
});

export default app;
