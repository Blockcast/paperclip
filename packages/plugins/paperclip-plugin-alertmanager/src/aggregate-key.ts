import type { AlertmanagerAlert } from "./types.js";

/** Creation dedup key: alertname by default, with an explicit rule-level domain escape hatch. */
export function aggregateKeyForAlert(alert: AlertmanagerAlert): string {
  const alertname = alert.labels.alertname ?? "UnnamedAlert";
  const domain =
    alert.labels.paperclip_dedupe_domain ??
    alert.annotations.paperclip_dedupe_domain ??
    null;
  return `alert-aggregate:v1:${JSON.stringify([alertname, domain])}`;
}
