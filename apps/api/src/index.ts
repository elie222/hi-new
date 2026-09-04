import { createApp } from "./app";
import type { Bindings } from "./context";
import { getDb } from "./db/client";
import { resendSender } from "./lib/email";
import { dailySweep, hourlySweep } from "./sweeps";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(event, env) {
    const db = getDb(env.DATABASE_URL);
    if (event.cron === "0 3 * * *") {
      await dailySweep(db, new Date(), {
        sendEmail: resendSender(env.RESEND_API_KEY),
        origin: env.APP_ORIGIN ?? "https://hi.new",
      });
    } else {
      await hourlySweep(db);
    }
  },
} satisfies ExportedHandler<Bindings>;
