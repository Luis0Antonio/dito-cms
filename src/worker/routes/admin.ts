import { Hono } from "hono";

import type { AppEnv } from "../lib/app";
import { requireAuth } from "../middleware/require-auth";
import { backupRouter } from "./admin-backup";
import { collectionsRouter } from "./admin-collections";
import { contactFormsRouter } from "./admin-contact-forms";
import { deployHookRouter } from "./admin-deploy-hook";
import { collectionEntriesRouter, entriesRouter } from "./admin-entries";
import { mediaRouter } from "./admin-media";
import { settingsRouter } from "./admin-settings";
import { storeRouter } from "./admin-store";

// Everything under /api/admin/* requires a session cookie or Bearer API key.
export const adminRouter = new Hono<AppEnv>();

adminRouter.use("*", requireAuth);

// Auth probe — confirms a session or API key resolves to a user.
adminRouter.get("/me", (c) =>
  c.json({ userId: c.get("authUserId"), via: c.get("authVia") }),
);

adminRouter.route("/collections", collectionsRouter);
adminRouter.route("/collections", collectionEntriesRouter);
adminRouter.route("/contact-forms", contactFormsRouter);
adminRouter.route("/entries", entriesRouter);
adminRouter.route("/media", mediaRouter);
adminRouter.route("/settings", settingsRouter);
adminRouter.route("/deploy-hook", deployHookRouter);
adminRouter.route("/backup", backupRouter);
adminRouter.route("/store", storeRouter);
