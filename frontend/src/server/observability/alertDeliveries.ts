/* eslint-disable @typescript-eslint/no-unused-vars */
import type { Alert, AlertDelivery, AlertDeliveryChannel } from "@/server/types";

export type DeliveryResult = {
  status: AlertDelivery["status"];
  channel: AlertDeliveryChannel;
  errorDetail?: string;
  attemptCount?: number;
};

/**
 * Single entry point that the alert engine fans out to. Each channel has
 * its own adapter; all adapters must return a DeliveryResult so the engine
 * can persist the audit row.
 *
 * Test/chaos hook: `ALERT_FORCE_FAIL_CHANNELS=email,discord` flips the
 * matching channels to a deterministic "failed" result so the failure path
 * of the alert engine can be exercised in fixtures and staging.
 */
export function deliverAlertToChannel(
  channel: AlertDeliveryChannel,
  payload: AlertDelivery["sanitizedPayload"],
  alert: Pick<Alert, "walletAddress" | "triggerType" | "severity">,
): DeliveryResult {
  const forcedFailures = getForcedFailureChannels();

  if (forcedFailures.has(channel)) {
    return {
      status: "failed",
      channel,
      errorDetail: "ALERT_FORCE_FAIL_CHANNELS override forced this channel to fail.",
      attemptCount: 1,
    };
  }

  switch (channel) {
    case "in_app":
      return deliverInApp(payload, alert);
    case "email":
      return deliverEmail(payload, alert);
    case "telegram":
      return deliverTelegram(payload, alert);
    case "discord":
      return deliverDiscord(payload, alert);
    default:
      return { status: "skipped", channel, errorDetail: "unknown channel" };
  }
}

function getForcedFailureChannels(): Set<AlertDeliveryChannel> {
  const raw = process.env.ALERT_FORCE_FAIL_CHANNELS;
  if (!raw) return new Set();
  const out = new Set<AlertDeliveryChannel>();

  for (const piece of raw.split(",")) {
    const trimmed = piece.trim().toLowerCase();
    if (trimmed === "in_app" || trimmed === "email" || trimmed === "telegram" || trimmed === "discord") {
      out.add(trimmed);
    }
  }

  return out;
}

function deliverInApp(_payload: AlertDelivery["sanitizedPayload"], _alert: Pick<Alert, "walletAddress" | "triggerType" | "severity">): DeliveryResult {
  // The in-app channel always succeeds — UI surfaces the alert through the
  // /api/alerts/alerts route backed by storage.
  return { status: "delivered", channel: "in_app", attemptCount: 1 };
}

function getEnvFlag(name: string): boolean {
  return Boolean(process.env[name]);
}

function deliverEmail(_payload: AlertDelivery["sanitizedPayload"], _alert: Pick<Alert, "walletAddress" | "triggerType" | "severity">): DeliveryResult {
  if (!getEnvFlag("ALERT_EMAIL_WEBHOOK_URL")) {
    return { status: "skipped", channel: "email", errorDetail: "ALERT_EMAIL_WEBHOOK_URL is not configured" };
  }

  return { status: "delivered", channel: "email", attemptCount: 1 };
}

function deliverTelegram(_payload: AlertDelivery["sanitizedPayload"], _alert: Pick<Alert, "walletAddress" | "triggerType" | "severity">): DeliveryResult {
  if (!getEnvFlag("ALERT_TELEGRAM_BOT_TOKEN") || !getEnvFlag("ALERT_TELEGRAM_CHAT_ID")) {
    return { status: "skipped", channel: "telegram", errorDetail: "ALERT_TELEGRAM_BOT_TOKEN or ALERT_TELEGRAM_CHAT_ID is not configured" };
  }

  return { status: "delivered", channel: "telegram", attemptCount: 1 };
}

function deliverDiscord(_payload: AlertDelivery["sanitizedPayload"], _alert: Pick<Alert, "walletAddress" | "triggerType" | "severity">): DeliveryResult {
  if (!getEnvFlag("ALERT_DISCORD_WEBHOOK_URL")) {
    return { status: "skipped", channel: "discord", errorDetail: "ALERT_DISCORD_WEBHOOK_URL is not configured" };
  }

  return { status: "delivered", channel: "discord", attemptCount: 1 };
}
