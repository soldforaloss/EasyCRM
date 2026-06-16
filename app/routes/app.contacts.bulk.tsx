import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getContact,
  getContactChannelCounts,
  listContacts,
  resolveOwnedContactIds,
} from "../lib/crm/contacts.server";
import {
  getSegment,
  parseSegmentCriteria,
} from "../lib/crm/segments.server";
import { buildMergeVarsMap, sendBulk } from "../lib/crm/messaging.server";
import { listTemplates } from "../lib/crm/templates.server";
import { getBrevoStatus } from "../lib/crm/settings.server";
import { isChannel } from "../lib/crm/constants";
import type { ContactListParams } from "../lib/crm/types";
import { ComposeMessage } from "../components/compose";

/** Resolve the recipient contact ids from `?id=...` (selection) or `?segment=...`. */
async function resolveRecipients(
  shop: string,
  ids: string[],
  segmentId: string | null,
): Promise<{ contactIds: string[]; label: string }> {
  if (segmentId) {
    const seg = await getSegment(shop, segmentId);
    if (!seg) return { contactIds: [], label: "segment (not found)" };
    const filter = parseSegmentCriteria(seg.criteria);
    const params: ContactListParams = {
      ...filter,
      sortField: "updatedAt",
      sortDir: "desc",
      page: 1,
      pageSize: 1000,
    };
    const list = await listContacts(shop, params);
    return { contactIds: list.rows.map((r) => r.id), label: `segment “${seg.name}”` };
  }
  const owned = await resolveOwnedContactIds(shop, ids);
  return { contactIds: owned, label: `${owned.length} selected contact(s)` };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const ids = url.searchParams.getAll("id");
  const segmentId = url.searchParams.get("segment");

  const { contactIds, label } = await resolveRecipients(shop, ids, segmentId);

  const [counts, templates, brevo, first] = await Promise.all([
    getContactChannelCounts(shop, contactIds),
    listTemplates(shop),
    getBrevoStatus(shop),
    contactIds[0] ? getContact(shop, contactIds[0]) : Promise.resolve(null),
  ]);

  const previewVars = first
    ? (await buildMergeVarsMap(shop, [first])).get(first.id) ?? {}
    : {};

  return {
    label,
    total: contactIds.length,
    contactIds,
    counts,
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      channel: t.channel,
      subject: t.subject,
      body: t.body,
    })),
    brevoConnected: brevo.connected,
    previewVars,
    segmentId,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  if (String(form.get("_action")) !== "sendBulk") {
    return { ok: false, toast: "Unknown action." };
  }
  const channel = String(form.get("channel") ?? "");
  if (!isChannel(channel)) return { ok: false, toast: "Choose a channel." };

  const ids = form.getAll("id").map(String);
  const segmentId = form.get("segment") ? String(form.get("segment")) : null;
  const { contactIds } = await resolveRecipients(shop, ids, segmentId);
  if (contactIds.length === 0) return { ok: false, toast: "No recipients to message." };

  try {
    const result = await sendBulk(shop, {
      contactIds,
      channel,
      subject: String(form.get("subject") ?? ""),
      body: String(form.get("body") ?? ""),
    });
    if (!result.ok) return { ok: false, toast: result.error ?? "Bulk send failed." };
    return {
      ok: true,
      toast: `Sent ${result.sent}, failed ${result.failed}, skipped ${result.skipped} of ${result.total}.`,
    };
  } catch (error) {
    return { ok: false, toast: error instanceof Error ? error.message : "Bulk send failed." };
  }
};

export default function BulkCompose() {
  const data = useLoaderData<typeof loader>();

  const hiddenFields: Record<string, string | string[]> = data.segmentId
    ? { segment: data.segmentId }
    : { id: data.contactIds };

  return (
    <s-page heading="Bulk message">
      <s-link slot="breadcrumb-actions" href="/app/contacts">
        Contacts
      </s-link>

      <s-section heading="Recipients">
        <s-stack direction="block" gap="small-200">
          <s-text>
            <s-text type="strong">Messaging: </s-text>
            {data.label}
          </s-text>
          <s-text color="subdued">
            {data.counts.withEmail} have an email address · {data.counts.withValidPhone} have a
            valid mobile number. Recipients missing the chosen channel are skipped and reported.
          </s-text>
          <s-text color="subdued">
            Cost note: Brevo bills SMS per message segment and email per send against your account
            credits. Review your Brevo plan before large sends.
          </s-text>
        </s-stack>
      </s-section>

      <s-section heading="Compose">
        {data.total === 0 ? (
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">No recipients selected.</s-paragraph>
            <s-button href="/app/contacts">Back to contacts</s-button>
          </s-stack>
        ) : !data.brevoConnected ? (
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">Connect Brevo in Settings to send messages.</s-paragraph>
            <s-button href="/app/settings">Go to Settings</s-button>
          </s-stack>
        ) : (
          <ComposeMessage
            heading="Bulk message"
            canEmail
            canSms
            previewVars={data.previewVars}
            templates={data.templates}
            hiddenFields={hiddenFields}
            actionValue="sendBulk"
            submitLabel={`Send to ${data.total} recipient${data.total === 1 ? "" : "s"}`}
            note={`The preview uses the first recipient's data. Each recipient is personalized individually.`}
          />
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
