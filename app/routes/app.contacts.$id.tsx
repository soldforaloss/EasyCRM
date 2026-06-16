import { useEffect, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useActionData,
  useFetcher,
  useLoaderData,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getContact, setLifecycleStage } from "../lib/crm/contacts.server";
import { addNote, deleteNote, editNote, listNotes } from "../lib/crm/notes.server";
import {
  listActivities,
  parseActivityPayload,
} from "../lib/crm/activity.server";
import { addTagToContact, removeTagFromContact } from "../lib/crm/tags.server";
import { createTask, listTasks, setTaskStatus } from "../lib/crm/tasks.server";
import { fetchCustomerDetail } from "../lib/shopify/customers.server";
import { buildMergeVarsMap, sendToContact } from "../lib/crm/messaging.server";
import { listTemplates } from "../lib/crm/templates.server";
import { getBrevoStatus } from "../lib/crm/settings.server";
import {
  ACTIVITY_TYPE_META,
  LIFECYCLE_STAGES,
  LIFECYCLE_STAGE_META,
  isActivityType,
  isChannel,
  type BadgeTone,
} from "../lib/crm/constants";
import { displayName, formatDate, formatDateTime, formatMoney } from "../lib/format";
import { StageBadge, TaskStatusBadge } from "../components/badges";
import { ComposeMessage } from "../components/compose";
import type { loader as ordersLoader } from "./app.contacts.$id_.orders";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const contact = await getContact(shop, params.id ?? "");
  if (!contact) throw new Response("Contact not found", { status: 404 });

  let live = null;
  let liveError: string | null = null;
  try {
    live = await fetchCustomerDetail(admin, contact.shopifyCustomerId, { orders: 10 });
    if (!live) liveError = "This customer no longer exists in Shopify.";
  } catch (error) {
    liveError = error instanceof Error ? error.message : "Could not load live customer data.";
  }

  const [notes, activities, tasks, templates, brevoStatus, varsMap] = await Promise.all([
    listNotes(shop, contact.id),
    listActivities(shop, contact.id, 100),
    listTasks(shop, { contactId: contact.id }),
    listTemplates(shop),
    getBrevoStatus(shop),
    buildMergeVarsMap(shop, [contact]),
  ]);

  const numericId = contact.shopifyCustomerId.split("/").pop();

  return {
    contact: {
      id: contact.id,
      name: displayName(contact.firstName, contact.lastName),
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      phone: contact.phone,
      stage: contact.lifecycleStage,
      source: contact.source,
      ordersCount: contact.ordersCount,
      amountSpent: contact.amountSpent,
      currencyCode: contact.currencyCode,
      tags: contact.tags.map((t) => ({ id: t.tag.id, name: t.tag.name })),
    },
    live,
    liveError,
    notes: notes.map((n) => ({ id: n.id, body: n.body, createdAt: n.createdAt })),
    timeline: activities.map((a) => ({
      id: a.id,
      type: a.type,
      occurredAt: a.occurredAt,
      payload: parseActivityPayload<Record<string, unknown>>(a),
    })),
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      dueAt: t.dueAt,
    })),
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      channel: t.channel,
      subject: t.subject,
      body: t.body,
    })),
    brevoConnected: brevoStatus.connected,
    previewVars: varsMap.get(contact.id) ?? {},
    shopifyCustomerUrl: `https://${shop}/admin/customers/${numericId}`,
    shop,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const contactId = params.id ?? "";
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");

  try {
    switch (intent) {
      case "setStage":
        await setLifecycleStage(shop, contactId, String(form.get("stage") ?? ""));
        return { ok: true, toast: "Lifecycle stage updated." };
      case "addNote":
        await addNote(shop, contactId, String(form.get("body") ?? ""));
        return { ok: true, toast: "Note added." };
      case "editNote":
        await editNote(shop, String(form.get("noteId") ?? ""), String(form.get("body") ?? ""));
        return { ok: true, toast: "Note updated." };
      case "deleteNote":
        await deleteNote(shop, String(form.get("noteId") ?? ""));
        return { ok: true, toast: "Note deleted." };
      case "addTag":
        await addTagToContact(shop, contactId, String(form.get("tagName") ?? ""));
        return { ok: true, toast: "Tag added." };
      case "removeTag":
        await removeTagFromContact(shop, contactId, String(form.get("tagId") ?? ""));
        return { ok: true, toast: "Tag removed." };
      case "createTask": {
        const due = String(form.get("dueAt") ?? "").trim();
        await createTask(shop, {
          title: String(form.get("title") ?? ""),
          contactId,
          dueAt: due ? new Date(`${due}T12:00:00`) : null,
        });
        return { ok: true, toast: "Task created." };
      }
      case "toggleTask":
        await setTaskStatus(
          shop,
          String(form.get("taskId") ?? ""),
          form.get("status") === "DONE" ? "DONE" : "OPEN",
        );
        return { ok: true, toast: "Task updated." };
      case "sendMessage": {
        const channel = String(form.get("channel") ?? "");
        if (!isChannel(channel)) return { ok: false, toast: "Choose a channel." };
        const outcome = await sendToContact(shop, {
          contactId,
          channel,
          subject: String(form.get("subject") ?? ""),
          body: String(form.get("body") ?? ""),
        });
        return outcome.ok
          ? { ok: true, toast: "Message sent." }
          : { ok: false, toast: outcome.error ?? "Send failed." };
      }
      default:
        return { ok: false, toast: "Unknown action." };
    }
  } catch (error) {
    return { ok: false, toast: error instanceof Error ? error.message : "Action failed." };
  }
};

function financialTone(status: string | null): BadgeTone {
  switch (status) {
    case "PAID":
    case "PARTIALLY_REFUNDED":
      return "success";
    case "PENDING":
    case "AUTHORIZED":
      return "caution";
    case "REFUNDED":
    case "VOIDED":
      return "critical";
    default:
      return "neutral";
  }
}

function describeTimeline(item: {
  type: string;
  payload: Record<string, unknown> | null;
}): string {
  const p = item.payload ?? {};
  switch (item.type) {
    case "NOTE":
      return String(p.preview ?? "Note added");
    case "ORDER_PLACED":
      return `${p.orderName ?? "Order"}${p.total ? ` · ${p.total} ${p.currency ?? ""}` : ""}`;
    case "STAGE_CHANGED":
      return `${p.from ?? "?"} → ${p.to ?? "?"}`;
    case "EMAIL_SENT":
    case "SMS_SENT":
      return String(p.subject ?? p.preview ?? "Message sent");
    case "TASK":
      return `${p.title ?? "Task"} (${p.action ?? "updated"})`;
    default:
      return "";
  }
}

export default function ContactDetail() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const { contact, live } = data;

  const lastToast = useRef<string | null>(null);
  useEffect(() => {
    if (actionData?.toast && actionData.toast !== lastToast.current) {
      lastToast.current = actionData.toast;
      shopify.toast.show(actionData.toast, actionData.ok ? {} : { isError: true });
    }
  }, [actionData, shopify]);

  // Live order history with "Load more" pagination via the orders resource route.
  const ordersFetcher = useFetcher<typeof ordersLoader>();
  const [extraOrders, setExtraOrders] = useState<
    NonNullable<typeof live>["orders"]["nodes"]
  >([]);
  const [cursor, setCursor] = useState(
    live?.orders.pageInfo ?? { hasNextPage: false, endCursor: null },
  );
  useEffect(() => {
    if (ordersFetcher.data?.orders) {
      setExtraOrders((prev) => [...prev, ...ordersFetcher.data!.orders]);
      setCursor(ordersFetcher.data.pageInfo);
    }
  }, [ordersFetcher.data]);

  const allOrders = [...(live?.orders.nodes ?? []), ...extraOrders];
  const loadingMore = ordersFetcher.state !== "idle";

  function loadMoreOrders() {
    if (cursor.endCursor) {
      ordersFetcher.load(`/app/contacts/${contact.id}/orders?after=${cursor.endCursor}`);
    }
  }

  const liveSpent = live?.amountSpent
    ? formatMoney(Number(live.amountSpent.amount), live.amountSpent.currencyCode)
    : formatMoney(contact.amountSpent, contact.currencyCode);
  const liveOrderCount = live ? Number(live.numberOfOrders) : contact.ordersCount;

  return (
    <s-page heading={contact.name}>
      <s-link slot="breadcrumb-actions" href="/app/contacts">
        Contacts
      </s-link>
      <s-button slot="primary-action" href={data.shopifyCustomerUrl} target="_blank">
        View in Shopify
      </s-button>

      {data.liveError && (
        <s-banner tone="warning" heading="Showing locally cached data">
          <s-paragraph>{data.liveError}</s-paragraph>
        </s-banner>
      )}

      {/* Send message ---------------------------------------------------- */}
      <s-section heading="Send a message">
        {data.brevoConnected ? (
          <ComposeMessage
            heading="Send a message"
            canEmail={Boolean(contact.email)}
            canSms={Boolean(contact.phone)}
            previewVars={data.previewVars}
            templates={data.templates}
            actionValue="sendMessage"
            submitLabel="Send message"
          />
        ) : (
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">
              Connect Brevo in Settings to send email and SMS to this contact.
            </s-paragraph>
            <s-button href="/app/settings">Go to Settings</s-button>
          </s-stack>
        )}
      </s-section>

      {/* Order history -------------------------------------------------- */}
      <s-section heading="Order history">
        {allOrders.length === 0 ? (
          <s-paragraph color="subdued">
            No orders in the last 60 days. (Older orders require a broader Shopify scope —
            see DECISIONS.md.)
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header>Order</s-table-header>
                <s-table-header>Date</s-table-header>
                <s-table-header>Payment</s-table-header>
                <s-table-header>Fulfillment</s-table-header>
                <s-table-header>Total</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {allOrders.map((o) => {
                  const numericOrderId = o.id.split("/").pop();
                  return (
                    <s-table-row key={o.id}>
                      <s-table-cell>
                        <s-link
                          href={`https://${data.shop}/admin/orders/${numericOrderId}`}
                          target="_blank"
                        >
                          {o.name}
                        </s-link>
                      </s-table-cell>
                      <s-table-cell>{formatDate(o.createdAt)}</s-table-cell>
                      <s-table-cell>
                        <s-badge tone={financialTone(o.displayFinancialStatus)}>
                          {o.displayFinancialStatus ?? "—"}
                        </s-badge>
                      </s-table-cell>
                      <s-table-cell>{o.displayFulfillmentStatus ?? "—"}</s-table-cell>
                      <s-table-cell>
                        {o.totalPriceSet
                          ? formatMoney(
                              Number(o.totalPriceSet.shopMoney.amount),
                              o.totalPriceSet.shopMoney.currencyCode,
                            )
                          : "—"}
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
            {cursor.hasNextPage && (
              <s-button
                onClick={loadMoreOrders}
                variant="tertiary"
                {...(loadingMore ? { loading: true } : {})}
              >
                Load more orders
              </s-button>
            )}
          </s-stack>
        )}
      </s-section>

      {/* Activity timeline ---------------------------------------------- */}
      <s-section heading="Activity timeline">
        {data.timeline.length === 0 ? (
          <s-paragraph color="subdued">
            No activity yet. Notes, orders, stage changes and messages will appear here.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="small-200">
            {data.timeline.map((item) => (
              <s-box key={item.id} padding="small-200" borderRadius="base" background="subdued">
                <s-stack direction="inline" gap="base" alignItems="start">
                  <s-icon
                    type={isActivityType(item.type) ? ACTIVITY_TYPE_META[item.type].icon : "info"}
                  />
                  <s-stack direction="block" gap="small-500">
                    <s-text type="strong">
                      {isActivityType(item.type) ? ACTIVITY_TYPE_META[item.type].label : "Activity"}
                    </s-text>
                    <s-text>{describeTimeline(item)}</s-text>
                  </s-stack>
                  <s-text color="subdued">{formatDateTime(item.occurredAt)}</s-text>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      {/* Notes ----------------------------------------------------------- */}
      <s-section heading="Notes">
        <s-stack direction="block" gap="base">
          <Form method="post">
            <input type="hidden" name="_action" value="addNote" />
            <s-stack direction="block" gap="small-200">
              <s-text-area name="body" label="Add a note" rows={3} required />
              <s-button type="submit" variant="primary">
                Add note
              </s-button>
            </s-stack>
          </Form>

          {data.notes.map((note) => (
            <s-box key={note.id} padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small-200">
                <s-text color="subdued">{formatDateTime(note.createdAt)}</s-text>
                <Form method="post">
                  <input type="hidden" name="_action" value="editNote" />
                  <input type="hidden" name="noteId" value={note.id} />
                  <s-stack direction="block" gap="small-200">
                    <s-text-area name="body" label="Note" value={note.body} rows={3} />
                    <s-stack direction="inline" gap="base">
                      <s-button type="submit" variant="secondary">
                        Save
                      </s-button>
                    </s-stack>
                  </s-stack>
                </Form>
                <Form method="post">
                  <input type="hidden" name="_action" value="deleteNote" />
                  <input type="hidden" name="noteId" value={note.id} />
                  <s-button type="submit" variant="tertiary" tone="critical">
                    Delete note
                  </s-button>
                </Form>
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      </s-section>

      {/* Tasks ----------------------------------------------------------- */}
      <s-section heading="Tasks">
        <s-stack direction="block" gap="base">
          <Form method="post">
            <input type="hidden" name="_action" value="createTask" />
            <s-stack direction="inline" gap="base" alignItems="end">
              <s-text-field name="title" label="New task" placeholder="Follow up…" required />
              <s-date-field name="dueAt" label="Due date" />
              <s-button type="submit" variant="primary">
                Add task
              </s-button>
            </s-stack>
          </Form>

          {data.tasks.length === 0 ? (
            <s-paragraph color="subdued">No tasks for this contact.</s-paragraph>
          ) : (
            <s-stack direction="block" gap="small-200">
              {data.tasks.map((task) => (
                <s-box
                  key={task.id}
                  padding="small-200"
                  borderRadius="base"
                  background="subdued"
                >
                  <s-stack direction="inline" gap="base" alignItems="center">
                    <TaskStatusBadge status={task.status} />
                    <s-stack direction="block" gap="small-500">
                      <s-text type="strong">{task.title}</s-text>
                      {task.dueAt && (
                        <s-text color="subdued">Due {formatDate(task.dueAt)}</s-text>
                      )}
                    </s-stack>
                    <Form method="post">
                      <input type="hidden" name="_action" value="toggleTask" />
                      <input type="hidden" name="taskId" value={task.id} />
                      <input
                        type="hidden"
                        name="status"
                        value={task.status === "DONE" ? "OPEN" : "DONE"}
                      />
                      <s-button type="submit" variant="tertiary">
                        {task.status === "DONE" ? "Reopen" : "Mark done"}
                      </s-button>
                    </Form>
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          )}
        </s-stack>
      </s-section>

      {/* Aside: profile, stage, tags, spend ----------------------------- */}
      <s-section slot="aside" heading="Profile">
        <s-stack direction="block" gap="small-200">
          <s-text>
            <s-text type="strong">Email: </s-text>
            {contact.email ?? "—"}
          </s-text>
          <s-text>
            <s-text type="strong">Phone: </s-text>
            {contact.phone ?? "—"}
          </s-text>
          {contact.source && (
            <s-text>
              <s-text type="strong">Source: </s-text>
              {contact.source}
            </s-text>
          )}
          {live && (
            <>
              <s-text>
                <s-text type="strong">Email marketing: </s-text>
                {live.emailMarketingState ?? "—"}
              </s-text>
              <s-text>
                <s-text type="strong">SMS marketing: </s-text>
                {live.smsMarketingState ?? "—"}
              </s-text>
            </>
          )}
          {live?.defaultAddress?.formatted && (
            <s-stack direction="block" gap="small-500">
              <s-text type="strong">Default address</s-text>
              {live.defaultAddress.formatted.map((line, i) => (
                <s-text key={i} color="subdued">
                  {line}
                </s-text>
              ))}
            </s-stack>
          )}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Spend">
        <s-stack direction="block" gap="small-200">
          <s-text>
            <s-text type="strong">Lifetime spend: </s-text>
            {liveSpent}
          </s-text>
          <s-text>
            <s-text type="strong">Orders: </s-text>
            {liveOrderCount}
          </s-text>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Lifecycle stage">
        <s-stack direction="block" gap="small-200">
          <StageBadge stage={contact.stage} />
          <Form method="post">
            <input type="hidden" name="_action" value="setStage" />
            <s-stack direction="inline" gap="base" alignItems="end">
              <s-select name="stage" label="Change stage" value={contact.stage}>
                {LIFECYCLE_STAGES.map((stage) => (
                  <s-option key={stage} value={stage}>
                    {LIFECYCLE_STAGE_META[stage].label}
                  </s-option>
                ))}
              </s-select>
              <s-button type="submit">Update</s-button>
            </s-stack>
          </Form>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Tags">
        <s-stack direction="block" gap="small-200">
          {contact.tags.length === 0 ? (
            <s-text color="subdued">No tags yet.</s-text>
          ) : (
            <s-stack direction="inline" gap="small-200">
              {contact.tags.map((tag) => (
                <Form key={tag.id} method="post">
                  <input type="hidden" name="_action" value="removeTag" />
                  <input type="hidden" name="tagId" value={tag.id} />
                  <s-button type="submit" variant="tertiary" icon="x">
                    {tag.name}
                  </s-button>
                </Form>
              ))}
            </s-stack>
          )}
          <Form method="post">
            <input type="hidden" name="_action" value="addTag" />
            <s-stack direction="inline" gap="base" alignItems="end">
              <s-text-field name="tagName" label="Add tag" placeholder="e.g. VIP" />
              <s-button type="submit">Add</s-button>
            </s-stack>
          </Form>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
