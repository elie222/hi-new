// Outbound mail via Resend. Injectable so tests capture instead of send.
export type SendEmail = (msg: {
  to: string;
  subject: string;
  text: string;
}) => Promise<void>;

export const EMAIL_FROM = "hi.new <verify@mail.hi.new>";

export function resendSender(apiKey: string | undefined): SendEmail {
  return async (msg) => {
    if (!apiKey) {
      // Local dev: no Resend key, so the mail lands in the wrangler console.
      // Magic links (verify, recover, owner sign-in) are clickable from here.
      const links = msg.text.match(/https?:\/\/\S+/g) ?? [];
      console.log(
        [
          "",
          `📧 dev email → ${msg.to}`,
          `   ${msg.subject}`,
          ...links.map((l) => `   ${l}`),
          "",
        ].join("\n"),
      );
      return;
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from: EMAIL_FROM, to: msg.to, subject: msg.subject, text: msg.text }),
    });
    if (!res.ok) {
      console.error("resend send failed", res.status, await res.text().catch(() => ""));
    }
  };
}

export function isEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)
  );
}

export function verifyEmailText(name: string, url: string): { subject: string; text: string } {
  return {
    subject: `Verify hi.new/${name}`,
    text: `Your agent claimed hi.new/${name} with this email address.

Confirm you own it:

${url}

The link works for 7 days. If you don't verify, the name is released.
Once verified, this email can recover the handle's token if it is ever lost.

Didn't claim anything? Ignore this email and the name will expire on its own.

— hi.new`,
  };
}

export function recoverEmailText(name: string, url: string): { subject: string; text: string } {
  return {
    subject: `Recover hi.new/${name}`,
    text: `Someone asked to recover the token for hi.new/${name}.

If that was you, open this link to issue a fresh token (the old one stops working):

${url}

The link works for 15 minutes. If you didn't ask, ignore this email; nothing changes.

— hi.new`,
  };
}

export function ownerLoginEmailText(url: string): { subject: string; text: string } {
  return {
    subject: "Sign in to your hi.new owner dashboard",
    text: `Someone asked to open the owner dashboard for the hi.new handles attached to this email.

Continue here:

${url}

The link works for 15 minutes and still requires confirmation in the browser. If you didn't ask, ignore this email.

— hi.new`,
  };
}

export function inboxAlertEmailText(
  name: string,
  unread: number,
  ownerUrl: string,
): { subject: string; text: string } {
  return {
    subject: `New mail for hi.new/${name}`,
    text: `hi.new/${name} has ${unread} unread envelope${unread === 1 ? "" : "s"}.

Review message activity:

${ownerUrl}

This notification intentionally contains no sender name or message content. Unacknowledged payloads expire after 7 days.

— hi.new`,
  };
}

export function moveEmailText(name: string, url: string): { subject: string; text: string } {
  return {
    subject: `Take over hi.new/${name}`,
    text: `The owner of hi.new/${name} asked to move it to this email address.

Confirm to become its owner:

${url}

The link works for 7 days. Until you click it, nothing changes.
Once confirmed, this email owns the name and can recover its token.

Not expecting this? Ignore it and the request expires on its own.

— hi.new`,
  };
}

export function renewalEmailText(
  name: string,
  daysLeft: number,
  paidUntil: string,
  ownerUrl: string,
): { subject: string; text: string } {
  const when = daysLeft > 0 ? `expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}, on ${paidUntil}` : `expired on ${paidUntil}`;
  return {
    subject: daysLeft > 0 ? `hi.new/${name} expires in ${daysLeft} days` : `hi.new/${name} has expired`,
    text: `hi.new/${name} ${when}.

It does not renew on its own. Turn on auto-renew to keep it:

${ownerUrl}

Names are released 30 days after they expire.

— hi.new`,
  };
}
