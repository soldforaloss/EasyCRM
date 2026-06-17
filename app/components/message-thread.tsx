/** Two-way communication threads built from MessageLog history (outbound + inbound). */

import { formatDateTime } from "../lib/format";
import { MessageStatusBadge } from "./badges";

export interface ThreadMessage {
  id: string;
  channel: string;
  direction: string; // OUTBOUND (we sent) | INBOUND (customer reply)
  subject: string | null;
  bodySnapshot: string;
  status: string;
  error: string | null;
  createdAt: Date | string;
}

function isInbound(m: ThreadMessage): boolean {
  return m.direction === "INBOUND";
}

function EmptyThread({ label }: { label: string }) {
  return (
    <s-stack direction="block" gap="small-200" alignItems="center" justifyContent="center">
      <s-text color="subdued">{label}</s-text>
    </s-stack>
  );
}

/**
 * SMS history as a two-sided chat thread: customer replies on the left (outlined), our outbound on
 * the right (filled). Status badges apply to outbound only (status is meaningless for inbound).
 */
export function SmsThread({ messages }: { messages: ThreadMessage[] }) {
  if (messages.length === 0) {
    return <EmptyThread label="No texts with this contact yet." />;
  }
  return (
    <s-stack direction="block" gap="base">
      {messages.map((m) => {
        const inbound = isInbound(m);
        return (
          <s-stack
            key={m.id}
            direction="block"
            gap="small-500"
            alignItems={inbound ? "start" : "end"}
          >
            <s-box
              padding="base"
              borderRadius="large"
              maxInlineSize="80%"
              {...(inbound ? { borderWidth: "base" } : { background: "subdued" })}
            >
              <s-text>{m.bodySnapshot}</s-text>
            </s-box>
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text color="subdued">
                {inbound ? "Customer · " : ""}
                {formatDateTime(m.createdAt)}
              </s-text>
              {!inbound && m.status !== "SENT" ? <MessageStatusBadge status={m.status} /> : null}
            </s-stack>
            {!inbound && m.error ? <s-text color="subdued">{m.error}</s-text> : null}
          </s-stack>
        );
      })}
    </s-stack>
  );
}

/** Email history as a thread of message cards, labelled by direction (received vs sent). */
export function EmailThread({ messages }: { messages: ThreadMessage[] }) {
  if (messages.length === 0) {
    return <EmptyThread label="No emails with this contact yet." />;
  }
  return (
    <s-stack direction="block" gap="base">
      {messages.map((m) => {
        const inbound = isInbound(m);
        return (
          <s-box key={m.id} padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small-200">
              <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
                <s-text type="strong">{m.subject || "(no subject)"}</s-text>
                {inbound ? (
                  <s-badge tone="info">Received</s-badge>
                ) : m.status !== "SENT" ? (
                  <MessageStatusBadge status={m.status} />
                ) : null}
              </s-stack>
              <s-text>{m.bodySnapshot}</s-text>
              <s-text color="subdued">
                {inbound ? "From customer · " : "Sent · "}
                {formatDateTime(m.createdAt)}
              </s-text>
              {!inbound && m.error ? (
                <s-text color="subdued">Delivery error: {m.error}</s-text>
              ) : null}
            </s-stack>
          </s-box>
        );
      })}
    </s-stack>
  );
}
