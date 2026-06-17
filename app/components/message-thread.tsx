/** Read-only communication threads built from MessageLog history (outbound only). */

import { formatDateTime } from "../lib/format";
import { MessageStatusBadge } from "./badges";

export interface ThreadMessage {
  id: string;
  channel: string;
  subject: string | null;
  bodySnapshot: string;
  status: string;
  error: string | null;
  createdAt: Date | string;
}

function EmptyThread({ label }: { label: string }) {
  return (
    <s-stack direction="block" gap="small-200" alignItems="center" justifyContent="center">
      <s-text color="subdued">{label}</s-text>
    </s-stack>
  );
}

/** SMS history rendered as a one-sided chat thread (every bubble is outbound from the shop). */
export function SmsThread({ messages }: { messages: ThreadMessage[] }) {
  if (messages.length === 0) {
    return <EmptyThread label="No texts sent to this contact yet." />;
  }
  return (
    <s-stack direction="block" gap="base">
      {messages.map((m) => (
        <s-stack key={m.id} direction="block" gap="small-500" alignItems="end">
          <s-box
            padding="base"
            borderRadius="large"
            background="subdued"
            maxInlineSize="80%"
          >
            <s-text>{m.bodySnapshot}</s-text>
          </s-box>
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text color="subdued">{formatDateTime(m.createdAt)}</s-text>
            {m.status !== "SENT" ? <MessageStatusBadge status={m.status} /> : null}
          </s-stack>
          {m.error ? <s-text color="subdued">{m.error}</s-text> : null}
        </s-stack>
      ))}
    </s-stack>
  );
}

/** Email history rendered as a thread of message cards. */
export function EmailThread({ messages }: { messages: ThreadMessage[] }) {
  if (messages.length === 0) {
    return <EmptyThread label="No emails sent to this contact yet." />;
  }
  return (
    <s-stack direction="block" gap="base">
      {messages.map((m) => (
        <s-box key={m.id} padding="base" borderWidth="base" borderRadius="base">
          <s-stack direction="block" gap="small-200">
            <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
              <s-text type="strong">{m.subject || "(no subject)"}</s-text>
              {m.status !== "SENT" ? <MessageStatusBadge status={m.status} /> : null}
            </s-stack>
            <s-text>{m.bodySnapshot}</s-text>
            <s-text color="subdued">{formatDateTime(m.createdAt)}</s-text>
            {m.error ? <s-text color="subdued">Delivery error: {m.error}</s-text> : null}
          </s-stack>
        </s-box>
      ))}
    </s-stack>
  );
}
