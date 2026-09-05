import { ANALYTICS_BOOTSTRAP } from "./analytics";

export function Analytics() {
  return <>
    <script dangerouslySetInnerHTML={{ __html: ANALYTICS_BOOTSTRAP }} />
    <script defer src="/analytics.js" />
  </>;
}
