import posthog from "posthog-js";
import { analyticsPath } from "./analytics";

declare const __POSTHOG_KEY__: string;

// SDK defaults can include credentials in URLs and private page content.
const SAFE_PROPERTIES = new Set([
  "token", "distinct_id", "$device_id", "$session_id", "$window_id",
  "$lib", "$lib_version", "$insert_id", "$time", "$process_person_profile",
  "$browser", "$browser_version", "$os", "$os_version", "$device_type",
  "$screen_height", "$screen_width", "$viewport_height", "$viewport_width",
  "source", "paid", "step",
]);

function startAnalytics() {
  if (!__POSTHOG_KEY__ || location.origin !== "https://hi.new" || window.hiAnalyticsLoaded) return;
  window.hiAnalyticsLoaded = true;
  posthog.init(__POSTHOG_KEY__, {
    api_host: "/r",
    ui_host: "https://us.posthog.com",
    defaults: "2026-05-30",
    persistence: "localStorage",
    person_profiles: "never",
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_dead_clicks: false,
    rageclick: false,
    capture_heatmaps: false,
    capture_performance: false,
    capture_exceptions: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_external_dependency_loading: true,
    save_referrer: false,
    save_campaign_params: false,
    advanced_disable_flags: true,
    before_send(event) {
      if (!event) return null;
      const properties = Object.fromEntries(
        Object.entries(event.properties).filter(([key]) => SAFE_PROPERTIES.has(key)),
      );
      const path = analyticsPath(location.pathname);
      properties.$current_url = location.origin + path;
      properties.$pathname = path;
      properties.$host = location.host;
      try {
        const referrer = new URL(document.referrer);
        properties.$referrer = referrer.origin;
        properties.$referring_domain = referrer.hostname;
      } catch {}
      event.properties = properties;
      return event;
    },
    loaded(client) {
      window.hiTrack = (event, properties) => {
        try {
          // Send before navigation can unload the page.
          client.capture(event, properties, { transport: "sendBeacon", send_instantly: true });
        } catch {}
      };
      client.capture("$pageview");
      const queued = window.hiAnalyticsQueue ?? [];
      window.hiAnalyticsQueue = [];
      for (const [event, properties] of queued) window.hiTrack(event, properties);
    },
  });
}

try { startAnalytics(); } catch { /* Analytics failures must not interrupt the app. */ }
