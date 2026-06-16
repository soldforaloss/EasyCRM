import { useEffect, useRef } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
  updateTemplate,
} from "../lib/crm/templates.server";
import { MERGE_VARIABLES } from "../lib/crm/types";
import { ChannelBadge } from "../components/badges";
import { ConfirmAction } from "../components/confirm";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const templates = await listTemplates(session.shop);
  return {
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      channel: t.channel,
      subject: t.subject,
      body: t.body,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");
  const input = {
    name: String(form.get("name") ?? ""),
    channel: String(form.get("channel") ?? ""),
    subject: String(form.get("subject") ?? ""),
    body: String(form.get("body") ?? ""),
  };
  try {
    switch (intent) {
      case "createTemplate":
        await createTemplate(shop, input);
        return { ok: true, toast: "Template created." };
      case "updateTemplate":
        await updateTemplate(shop, String(form.get("id") ?? ""), input);
        return { ok: true, toast: "Template updated." };
      case "deleteTemplate":
        await deleteTemplate(shop, String(form.get("id") ?? ""));
        return { ok: true, toast: "Template deleted." };
      default:
        return { ok: false, toast: "Unknown action." };
    }
  } catch (error) {
    return { ok: false, toast: error instanceof Error ? error.message : "Action failed." };
  }
};

function MergeHelp() {
  return (
    <s-text color="subdued">
      Merge variables:{" "}
      {MERGE_VARIABLES.map((v) => `{{${v.key}}}`).join(", ")}
    </s-text>
  );
}

export default function TemplatesPage() {
  const { templates } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const lastToast = useRef<string | null>(null);
  useEffect(() => {
    if (actionData?.toast && actionData.toast !== lastToast.current) {
      lastToast.current = actionData.toast;
      shopify.toast.show(actionData.toast, actionData.ok ? {} : { isError: true });
    }
  }, [actionData, shopify]);

  return (
    <s-page heading="Message templates">
      <s-section heading="New template">
        <Form method="post">
          <input type="hidden" name="_action" value="createTemplate" />
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" alignItems="end">
              <s-text-field name="name" label="Name" placeholder="Welcome email" required />
              <s-select name="channel" label="Channel">
                <s-option value="EMAIL">Email</s-option>
                <s-option value="SMS">SMS</s-option>
              </s-select>
            </s-stack>
            <s-text-field name="subject" label="Subject (email only)" placeholder="Thanks for your order, {{firstName}}!" />
            <s-text-area name="body" label="Body" rows={5} required />
            <MergeHelp />
            <s-button type="submit" variant="primary">
              Create template
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      {templates.length === 0 ? (
        <s-section heading="No templates yet">
          <s-paragraph color="subdued">
            Create reusable email and SMS templates with merge variables to speed up messaging.
          </s-paragraph>
        </s-section>
      ) : (
        templates.map((t) => (
          <s-section key={t.id} heading={t.name}>
            <s-stack direction="block" gap="base">
              <ChannelBadge channel={t.channel} />
              <Form method="post">
                <input type="hidden" name="_action" value="updateTemplate" />
                <input type="hidden" name="id" value={t.id} />
                <s-stack direction="block" gap="base">
                  <s-stack direction="inline" gap="base" alignItems="end">
                    <s-text-field name="name" label="Name" value={t.name} required />
                    <s-select name="channel" label="Channel" value={t.channel}>
                      <s-option value="EMAIL">Email</s-option>
                      <s-option value="SMS">SMS</s-option>
                    </s-select>
                  </s-stack>
                  <s-text-field name="subject" label="Subject (email only)" value={t.subject ?? ""} />
                  <s-text-area name="body" label="Body" value={t.body} rows={5} required />
                  <MergeHelp />
                  <s-stack direction="inline" gap="base">
                    <s-button type="submit" variant="secondary">
                      Save changes
                    </s-button>
                  </s-stack>
                </s-stack>
              </Form>
              <ConfirmAction
                id={`confirm-del-template-${t.id}`}
                triggerLabel="Delete template"
                heading="Delete template?"
                message={`The template “${t.name}” will be permanently removed.`}
                confirmLabel="Delete template"
                fields={{ _action: "deleteTemplate", id: t.id }}
              />
            </s-stack>
          </s-section>
        ))
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
