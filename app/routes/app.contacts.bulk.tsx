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
import { buildMergeVarsMap } from "../lib/crm/messaging.server";
import { createBulkSend } from "../lib/crm/bulk.server";
import { listTemplates } from "../lib/crm/templates.server";
import { getBrevoStatus } from "../lib/crm/settings.server";
import { isChannel } from "../lib/crm/constants";
import { staffIdFromSessionToken } from "../lib/staff.server";
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
  const { session, sessionToken } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  if (String(form.get("_action")) !== "sendBulk") {
    return { ok: false, toast: "Unknown action." };
  }
  const channel = String(form.get("channel") ?? "");
  if (!isChannel(channel)) return { ok: false, toast: "Choose a channel." };

  const body = String(form.get("body") ?? "").trim();
  if (!body) return { ok: false, toast: "Write a message before sending." };

  const ids = form.getAll("id").map(String);
  const segmentId = form.get("segment") ? String(form.get("segment")) : null;
  const { contactIds, label } = await resolveRecipients(shop, ids, segmentId);

  // Queue the send and return immediately. The request never talks to Brevo — a large batch
  // would otherwise exceed the platform request timeout mid-send. See DECISIONS.md §11.
  try {
    const result = await createBulkSend({
      shop,
      channel,
      subject: String(form.get("subject") ?? ""),
      body,
      contactIds,
      createdByStaffId: staffIdFromSessionToken(sessionToken),
      label,
    });
    if (!result.ok || !result.batch) {
      return { ok: false, toast: result.error ?? "Bulk send could not be queued." };
    }
    const total = result.batch.total;
    return {
      ok: true,
      batchId: result.batch.id,
      toast: `Queued ${total} message${total === 1 ? "" : "s"}. Recipients who aren't subscribed will be skipped automatically.`,
    };
  } catch (error) {
    return {
      ok: false,
      toast: error instanceof Error ? error.message : "Bulk send could not be queued.",
    };
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
            <s-text type="strong">{data.counts.emailReachable}</s-text> can receive email ·{" "}
            <s-text type="strong">{data.counts.smsReachable}</s-text> can receive SMS.
          </s-text>
          {data.counts.emailNoConsent > 0 || data.counts.smsNoConsent > 0 ? (
            <s-text color="subdued">
              Not subscribed to marketing and therefore skipped:{" "}
              {data.counts.emailNoConsent} for email, {data.counts.smsNoConsent} for SMS. Easy CRM
              only messages customers who opted in through Shopify.
            </s-text>
          ) : null}
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
