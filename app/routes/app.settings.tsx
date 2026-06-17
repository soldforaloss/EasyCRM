import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useState } from "react";
import { Form, useActionData, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getBrevoStatus,
  getInboundConfig,
  getOrCreateInboundToken,
  removeBrevoKey,
  rotateInboundToken,
  saveBrevoKey,
  setInboundSecret,
  updateSenderSettings,
} from "../lib/crm/settings.server";
import { sendTestMessage } from "../lib/crm/messaging.server";
import { isChannel } from "../lib/crm/constants";
import { ConfirmAction } from "../components/confirm";
import { useActionToast } from "../lib/use-action-toast";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [status, inbound] = await Promise.all([
    getBrevoStatus(session.shop),
    getInboundConfig(session.shop),
  ]);
  // The webhook URL the merchant pastes into Brevo. Prefer the configured app URL; fall back to the
  // request origin (the embedded app / tunnel host).
  const origin = process.env.SHOPIFY_APP_URL ?? new URL(request.url).origin;
  const inboundWebhookUrl = inbound.token
    ? `${origin.replace(/\/$/, "")}/webhooks/brevo/${inbound.token}`
    : null;
  return { status, inbound: { secretSet: inbound.secretSet, webhookUrl: inboundWebhookUrl } };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");
  try {
    switch (intent) {
      case "saveKey": {
        const result = await saveBrevoKey(shop, String(form.get("apiKey") ?? ""));
        return result.ok
          ? { ok: true, toast: `Brevo connected${result.accountEmail ? ` as ${result.accountEmail}` : ""}.` }
          : { ok: false, toast: result.error ?? "Could not connect to Brevo." };
      }
      case "removeKey":
        await removeBrevoKey(shop);
        return { ok: true, toast: "Brevo disconnected." };
      case "saveSender":
        await updateSenderSettings(shop, {
          senderEmail: String(form.get("senderEmail") ?? ""),
          senderName: String(form.get("senderName") ?? ""),
          smsSender: String(form.get("smsSender") ?? ""),
        });
        return { ok: true, toast: "Sender settings saved." };
      case "sendTest": {
        const channel = String(form.get("channel") ?? "");
        if (!isChannel(channel)) return { ok: false, toast: "Choose a channel." };
        const result = await sendTestMessage(
          shop,
          channel,
          String(form.get("recipient") ?? ""),
        );
        return result.ok
          ? { ok: true, toast: "Test message sent." }
          : { ok: false, toast: result.error ?? "Test send failed." };
      }
      case "generateInboundUrl":
        await getOrCreateInboundToken(shop);
        return { ok: true, toast: "Inbound webhook URL generated." };
      case "rotateInboundToken":
        await rotateInboundToken(shop);
        return { ok: true, toast: "New URL generated — update it in Brevo (the old one stops working)." };
      case "saveInboundSecret": {
        const secret = String(form.get("inboundSecret") ?? "").trim();
        await setInboundSecret(shop, secret || null);
        return { ok: true, toast: secret ? "Inbound secret saved." : "Inbound secret cleared." };
      }
      default:
        return { ok: false, toast: "Unknown action." };
    }
  } catch (error) {
    return { ok: false, toast: error instanceof Error ? error.message : "Action failed." };
  }
};

export default function SettingsPage() {
  const { status, inbound } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  // The inbound secret carries a Polaris field value, so it submits via a fetcher with controlled
  // state (native <Form> submits don't reliably capture web-component values — see the gotchas).
  const secretFetcher = useFetcher<{ ok: boolean; toast?: string }>();
  const [inboundSecret, setInboundSecret] = useState("");
  useActionToast(actionData);
  useActionToast(secretFetcher.data);
  const savingSecret = secretFetcher.state !== "idle";

  return (
    <s-page heading="Settings">
      {!status.encryptionConfigured && (
        <s-banner tone="critical" heading="Encryption key not configured">
          <s-paragraph>
            Set the <code>ENCRYPTION_KEY</code> environment variable so the Brevo API key can be
            stored securely (AES-256-GCM). Until then, connecting Brevo is disabled.
          </s-paragraph>
        </s-banner>
      )}

      {/* Brevo connection ----------------------------------------------- */}
      <s-section heading="Brevo connection">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-text type="strong">Status:</s-text>
            {status.connected ? (
              <s-badge tone="success">
                Connected{status.accountEmail ? ` · ${status.accountEmail}` : ""}
              </s-badge>
            ) : (
              <s-badge tone="warning">Not connected</s-badge>
            )}
          </s-stack>

          <Form method="post">
            <input type="hidden" name="_action" value="saveKey" />
            <s-stack direction="block" gap="small-200">
              <s-password-field
                name="apiKey"
                label="Brevo REST API key"
                placeholder="xkeysib-…"
                {...(status.encryptionConfigured ? {} : { disabled: true })}
              />
              <s-text color="subdued">
                Find this in Brevo under SMTP &amp; API → API Keys. The key is validated against
                your Brevo account, then encrypted at rest. It is never shown again.
              </s-text>
              <s-button
                type="submit"
                variant="primary"
                {...(status.encryptionConfigured ? {} : { disabled: true })}
              >
                {status.connected ? "Replace key" : "Connect Brevo"}
              </s-button>
            </s-stack>
          </Form>

          {status.connected && (
            <ConfirmAction
              id="confirm-disconnect-brevo"
              triggerLabel="Disconnect Brevo"
              heading="Disconnect Brevo?"
              message="Your encrypted Brevo API key will be removed. You'll need to re-enter it to send messages again."
              confirmLabel="Disconnect"
              fields={{ _action: "removeKey" }}
            />
          )}
        </s-stack>
      </s-section>

      {/* Sender settings ------------------------------------------------- */}
      <s-section heading="Sender identity">
        <Form method="post">
          <input type="hidden" name="_action" value="saveSender" />
          <s-stack direction="block" gap="base">
            <s-email-field
              name="senderEmail"
              label="Sender email (must be a verified Brevo sender)"
              value={status.senderEmail ?? ""}
              placeholder="hello@yourshop.com"
            />
            <s-text-field
              name="senderName"
              label="Sender name"
              value={status.senderName ?? ""}
              placeholder="Your Shop"
            />
            <s-text-field
              name="smsSender"
              label="SMS sender ID (max 11 alphanumeric characters)"
              value={status.smsSender ?? ""}
              placeholder="YourShop"
              maxLength={11}
            />
            <s-button type="submit" variant="primary">
              Save sender settings
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      {/* Deliverability note -------------------------------------------- */}
      <s-section heading="Deliverability">
        <s-banner tone="info">
          <s-paragraph>
            For reliable email delivery, authenticate your sender domain (DKIM) in your Brevo
            account. Without it, Brevo may rewrite the sending domain, which can hurt
            deliverability. SMS requires sufficient Brevo SMS credits.
          </s-paragraph>
        </s-banner>
      </s-section>

      {/* Test send ------------------------------------------------------- */}
      <s-section heading="Send a test message">
        {status.connected ? (
          <Form method="post">
            <input type="hidden" name="_action" value="sendTest" />
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="base" alignItems="end">
                <s-select name="channel" label="Channel">
                  <s-option value="EMAIL">Email</s-option>
                  <s-option value="SMS">SMS</s-option>
                </s-select>
                <s-text-field
                  name="recipient"
                  label="Recipient (email or E.164 phone)"
                  placeholder="you@example.com or +15551234567"
                  required
                />
                <s-button type="submit">Send test</s-button>
              </s-stack>
            </s-stack>
          </Form>
        ) : (
          <s-paragraph color="subdued">Connect Brevo above to send a test message.</s-paragraph>
        )}
      </s-section>

      {/* Receiving messages (inbound) ----------------------------------- */}
      <s-section heading="Receiving messages">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            Capture customer email and SMS replies via Brevo Conversations webhooks so they appear in
            each contact&apos;s Messages thread. This can&apos;t be set up automatically — generate the
            URL below and add it in Brevo.
          </s-paragraph>

          {inbound.webhookUrl ? (
            <>
              <s-stack direction="block" gap="small-200">
                <s-text type="strong">Your webhook URL</s-text>
                <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
                  <s-text>{inbound.webhookUrl}</s-text>
                </s-box>
                <s-stack direction="inline" gap="base">
                  <s-button onClick={() => navigator.clipboard?.writeText(inbound.webhookUrl!)}>
                    Copy URL
                  </s-button>
                  <ConfirmAction
                    id="confirm-rotate-inbound"
                    triggerLabel="Rotate URL"
                    heading="Rotate webhook URL?"
                    message="A new URL is generated and the current one stops working. You'll need to update it in Brevo."
                    confirmLabel="Rotate URL"
                    fields={{ _action: "rotateInboundToken" }}
                  />
                </s-stack>
              </s-stack>

              <s-stack direction="block" gap="small-200">
                <s-text-field
                  label="Optional basic-auth secret"
                  value={inboundSecret}
                  placeholder={inbound.secretSet ? "•••••••• (a secret is set)" : "Leave blank for none"}
                  onInput={(event) =>
                    setInboundSecret((event.target as HTMLInputElement | null)?.value ?? "")
                  }
                />
                <s-text color="subdued">
                  If set, Brevo must send it as a Bearer token or basic-auth password on the webhook.
                </s-text>
                <s-button
                  variant="secondary"
                  onClick={() =>
                    secretFetcher.submit(
                      { _action: "saveInboundSecret", inboundSecret },
                      { method: "post" },
                    )
                  }
                  {...(savingSecret ? { loading: true, disabled: true } : {})}
                >
                  Save secret
                </s-button>
              </s-stack>

              <s-banner tone="info" heading="Set it up in Brevo">
                <s-ordered-list>
                  <s-list-item>Enable Brevo Conversations on your account.</s-list-item>
                  <s-list-item>
                    For two-way SMS, provision a dedicated number (US/CA/FR; France can&apos;t receive
                    replies) and route SMS into Conversations.
                  </s-list-item>
                  <s-list-item>
                    In Brevo → Conversations → Settings → Integrations → Webhooks, add the URL above
                    (and the secret, if you set one).
                  </s-list-item>
                </s-ordered-list>
                <s-paragraph>
                  Only email and SMS are threaded into contacts; chat and social sources are ignored.
                </s-paragraph>
              </s-banner>
            </>
          ) : (
            <Form method="post">
              <input type="hidden" name="_action" value="generateInboundUrl" />
              <s-button type="submit" variant="primary">
                Generate webhook URL
              </s-button>
            </Form>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
