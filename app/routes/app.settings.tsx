import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getBrevoStatus,
  removeBrevoKey,
  saveBrevoKey,
  updateSenderSettings,
} from "../lib/crm/settings.server";
import { sendTestMessage } from "../lib/crm/messaging.server";
import { isChannel } from "../lib/crm/constants";
import { ConfirmAction } from "../components/confirm";
import { useActionToast } from "../lib/use-action-toast";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { status: await getBrevoStatus(session.shop) };
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
      default:
        return { ok: false, toast: "Unknown action." };
    }
  } catch (error) {
    return { ok: false, toast: error instanceof Error ? error.message : "Action failed." };
  }
};

export default function SettingsPage() {
  const { status } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  useActionToast(actionData);

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
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
