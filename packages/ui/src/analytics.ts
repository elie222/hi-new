export type AnalyticsEvent =
  | "claim_started"
  | "claim_created"
  | "checkout_started"
  | "setup_step_viewed"
  | "setup_prompt_copied"
  | "owner_email_requested"
  | "invite_created"
  | "agent_claim_prompt_copied";

export type AnalyticsProperties = {
  source?: "landing" | "profile" | "setup";
  paid?: boolean;
  step?: "ceremony" | "paste" | "email" | "live";
};

declare global {
  interface Window {
    hiTrack?: (event: AnalyticsEvent, properties?: AnalyticsProperties) => void;
    hiAnalyticsQueue?: [AnalyticsEvent, AnalyticsProperties?][];
    hiAnalyticsLoaded?: boolean;
  }
}

export function track(event: AnalyticsEvent, properties?: AnalyticsProperties): void {
  try {
    const browser = (globalThis as { window?: Window }).window;
    browser?.hiTrack?.(event, properties);
  } catch {}
}

// Queue events until the deferred SDK loads.
export const ANALYTICS_BOOTSTRAP = `if(location.origin==="https://hi.new"&&!window.hiTrack){window.hiAnalyticsQueue=[];window.hiTrack=function(e,p){if(window.hiAnalyticsQueue.length<50)window.hiAnalyticsQueue.push([e,p])}}`;

export function analyticsPath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  if (!parts.length) return "/";
  if (["connect", "setup", "profile", "owner", "recover"].includes(parts[0]!)) return "/" + parts[0];
  if (["i", "g"].includes(parts[0]!)) return "/" + parts[0] + "/:token";
  if (parts[0] === "buy") return "/buy/:name";
  if (parts.length === 2 && parts[1] === "setup") return "/:name/setup";
  return parts.length === 1 ? "/:name" : "/other";
}
