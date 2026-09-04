import { and, eq, inArray, sql } from "drizzle-orm";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import {
  notificationDestinations,
  type Handle,
  type NotificationDestination,
} from "../db/schema";
import { inboxAlertEmailText } from "./email";
import {
  deliverNotificationDestination,
  type InboxNotificationEvent,
} from "./notification-destinations";
import { deliverWebhook } from "./webhook";

export type InboxNotificationRecipient = Pick<
  Handle,
  | "id"
  | "name"
  | "email"
  | "emailVerifiedAt"
  | "ownerNotifications"
  | "webhookUrl"
>;

export type InboxDeliveryState = {
  unread: number | null;
  becameUnread: boolean;
};

interface InboxNotifier {
  deliver(event: InboxNotificationEvent): Promise<void>;
}

type InboxNotification = {
  recipient: InboxNotificationRecipient;
  state: InboxDeliveryState & { unread: number };
};

export interface InboxNotificationPlan {
  tracks(recipientId: number): boolean;
  dispatch(statesByRecipient: ReadonlyMap<number, InboxDeliveryState>): void;
}

function emailNotifier(
  c: Context<AppEnv>,
  recipient: InboxNotificationRecipient,
  state: InboxNotification["state"],
): InboxNotifier | null {
  if (
    !state.becameUnread ||
    !recipient.ownerNotifications ||
    !recipient.email ||
    !recipient.emailVerifiedAt
  ) {
    return null;
  }
  return {
    deliver: async () => {
      const mail = inboxAlertEmailText(
        recipient.name,
        state.unread,
        `${c.get("origin")}/owner`,
      );
      await c.get("sendEmail")({ to: recipient.email!, ...mail });
    },
  };
}

function legacyWebhookNotifier(
  recipient: InboxNotificationRecipient,
): InboxNotifier | null {
  if (!recipient.webhookUrl) return null;
  return {
    deliver: (event) =>
      deliverWebhook(recipient.webhookUrl!, event.to, event.unread),
  };
}

function storedNotifier(
  c: Context<AppEnv>,
  destination: NotificationDestination,
  encryptionKey: string,
): InboxNotifier {
  const db = c.get("db");
  return {
    deliver: async (event) => {
      const result = await deliverNotificationDestination(
        encryptionKey,
        destination,
        event,
      );
      const now = new Date();
      await db
        .update(notificationDestinations)
        .set(
          result.ok
            ? {
                failureCount: 0,
                lastAttemptAt: now,
                lastSuccessAt: now,
                lastError: null,
                updatedAt: now,
              }
            : {
                failureCount: sql`${notificationDestinations.failureCount} + 1`,
                lastAttemptAt: now,
                lastError: result.error,
                updatedAt: now,
              },
        )
        .where(eq(notificationDestinations.id, destination.id));
    },
  };
}

async function storedDestinations(
  c: Context<AppEnv>,
  recipientIds: readonly number[],
): Promise<NotificationDestination[]> {
  const encryptionKey = c.get("notificationEncryptionKey");
  if (!encryptionKey || recipientIds.length === 0) return [];
  return c
    .get("db")
    .select()
    .from(notificationDestinations)
    .where(
      and(
        inArray(notificationDestinations.handleId, [...recipientIds]),
        eq(notificationDestinations.active, true),
      ),
    );
}

async function deliverInboxNotifications(
  c: Context<AppEnv>,
  notifications: readonly InboxNotification[],
  destinations: readonly NotificationDestination[],
): Promise<void> {
  const byRecipient = new Map(
    notifications.map((notification) => [
      notification.recipient.id,
      notification,
    ]),
  );
  const deliveries = notifications.flatMap(({ recipient, state }) => {
    const event: InboxNotificationEvent = {
      event: "inbox.new",
      to: recipient.name,
      unread: state.unread,
    };
    return [
      emailNotifier(c, recipient, state),
      legacyWebhookNotifier(recipient),
    ]
      .filter((notifier): notifier is InboxNotifier => notifier !== null)
      .map((notifier) => notifier.deliver(event));
  });
  const encryptionKey = c.get("notificationEncryptionKey");
  if (encryptionKey) {
    for (const destination of destinations) {
      const notification = byRecipient.get(destination.handleId);
      if (!notification) continue;
      const event: InboxNotificationEvent = {
        event: "inbox.new",
        to: notification.recipient.name,
        unread: notification.state.unread,
      };
      deliveries.push(
        storedNotifier(c, destination, encryptionKey).deliver(event),
      );
    }
  }
  await Promise.allSettled(deliveries);
}

function hasBuiltInNotification(
  recipient: InboxNotificationRecipient,
): boolean {
  return Boolean(
    recipient.webhookUrl ||
    (recipient.ownerNotifications &&
      recipient.email &&
      recipient.emailVerifiedAt),
  );
}

export async function prepareInboxNotifications(
  c: Context<AppEnv>,
  recipients: readonly InboxNotificationRecipient[],
): Promise<InboxNotificationPlan> {
  const uniqueRecipients = [
    ...new Map(
      recipients.map((recipient) => [recipient.id, recipient]),
    ).values(),
  ];
  const destinations = await storedDestinations(
    c,
    uniqueRecipients.map((recipient) => recipient.id),
  );
  const trackedRecipientIds = new Set(
    destinations.map((destination) => destination.handleId),
  );
  for (const recipient of uniqueRecipients) {
    if (hasBuiltInNotification(recipient))
      trackedRecipientIds.add(recipient.id);
  }
  return {
    tracks: (recipientId) => trackedRecipientIds.has(recipientId),
    dispatch: (statesByRecipient) => {
      const notifications = uniqueRecipients.flatMap((recipient) => {
        if (!trackedRecipientIds.has(recipient.id)) return [];
        const state = statesByRecipient.get(recipient.id);
        if (!state || state.unread === null) return [];
        return [{ recipient, state: { ...state, unread: state.unread } }];
      });
      if (notifications.length === 0) return;
      c.get("waitUntil")(
        deliverInboxNotifications(c, notifications, destinations),
      );
    },
  };
}
