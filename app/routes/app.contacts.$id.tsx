import { useEffect, useState } from "react";
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
import {
  displayName,
  formatDate,
  formatDateTime,
  formatDurationDays,
  formatMoney,
  initials,
} from "../lib/format";
import { computeInsights } from "../lib/crm/insights";
import { StageBadge, TaskStatusBadge } from "../components/badges";
import { ComposeMessage } from "../components/compose";
import { ConfirmAction } from "../components/confirm";
import { useActionToast } from "../lib/use-action-toast";
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

  const insights = live
    ? computeInsights({
        amountSpent: live.amountSpent ? Number(live.amountSpent.amount) : contact.amountSpent,
        numberOfOrders: live.numberOfOrders ? Number(live.numberOfOrders) : contact.ordersCount,
        customerSince: live.createdAt,
        firstOrderAt: live.firstOrderAt,
        lastOrderAt: live.lastOrderAt,
        orders: live.orders.nodes,
      })
    : null;

  return {
    insights,
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
      shopifyCustomerId: contact.shopifyCustomerId,
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

const TABS = ["Summary", "Orders", "Activity", "Notes & Tasks", "Details"] as const;
type Tab = (typeof TABS)[number];

const ACTIVITY_FILTERS: ReadonlyArray<{
  id: string;
  label: string;
  types: string[] | null;
}> = [
  { id: "ALL", label: "All", types: null },
  { id: "NOTE", label: "Notes", types: ["NOTE"] },
  { id: "ORDER", label: "Orders", types: ["ORDER_PLACED"] },
  { id: "MESSAGE", label: "Messages", types: ["EMAIL_SENT", "SMS_SENT"] },
  { id: "TASK", label: "Tasks", types: ["TASK"] },
  { id: "STAGE", label: "Stage", types: ["STAGE_CHANGED"] },
];

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
      <s-stack direction="block" gap="small-500">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        {sub ? <s-text color="subdued">{sub}</s-text> : null}
      </s-stack>
    </s-box>
  );
}

export default function ContactDetail() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const { contact, live, insights } = data;
  useActionToast(actionData);

  const [tab, setTab] = useState<Tab>("Summary");
  const [activityFilter, setActivityFilter] = useState<string>("ALL");

  // Live order history with "Load more" pagination via the orders resource route.
  const ordersFetcher = useFetcher<typeof ordersLoader>();
  const [extraOrders, setExtraOrders] = useState<
    NonNullable<typeof live>["orders"]["nodes"]
  >([]);
  const [cursor, setCursor] = useState(
    live?.orders.pageInfo ?? { hasNextPage: false, endCursor: null },
  );
  // The detail route module is reused across contacts, so reset order pagination on contact change.
  useEffect(() => {
    setExtraOrders([]);
    setCursor(live?.orders.pageInfo ?? { hasNextPage: false, endCursor: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contact.id]);
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

  const currency = live?.amountSpent?.currencyCode ?? contact.currencyCode;
  const liveSpent = live?.amountSpent
    ? formatMoney(Number(live.amountSpent.amount), currency)
    : formatMoney(contact.amountSpent, currency);
  const liveOrderCount = live ? Number(live.numberOfOrders) : contact.ordersCount;
  const location = [
    live?.defaultAddress?.city,
    live?.defaultAddress?.province || live?.defaultAddress?.country,
  ]
    .filter(Boolean)
    .join(", ");

  const activeFilter =
    ACTIVITY_FILTERS.find((f) => f.id === activityFilter) ?? ACTIVITY_FILTERS[0];
  const filteredTimeline = activeFilter.types
    ? data.timeline.filter((t) => activeFilter.types!.includes(t.type))
    : data.timeline;

  const recentOrders = allOrders.slice(0, 3);
  const recentActivity = data.timeline.slice(0, 5);
  const openTasks = data.tasks.filter((t) => t.status !== "DONE");

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

      {/* Identity header ------------------------------------------------- */}
      <s-section>
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-avatar initials={initials(contact.firstName, contact.lastName)} size="base" alt={contact.name} />
            <s-stack direction="block" gap="small-500">
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-heading>{contact.name}</s-heading>
                <StageBadge stage={contact.stage} />
                {live?.verifiedEmail ? <s-badge tone="success">Verified email</s-badge> : null}
                {insights?.atRisk ? <s-badge tone="critical">At risk</s-badge> : null}
              </s-stack>
              <s-stack direction="inline" gap="base">
                {contact.email ? (
                  <s-link href={`mailto:${contact.email}`}>{contact.email}</s-link>
                ) : (
                  <s-text color="subdued">No email</s-text>
                )}
                {contact.phone ? <s-link href={`tel:${contact.phone}`}>{contact.phone}</s-link> : null}
                {location ? <s-text color="subdued">{location}</s-text> : null}
              </s-stack>
            </s-stack>
          </s-stack>
          {contact.tags.length > 0 && (
            <s-stack direction="inline" gap="small-200">
              {contact.tags.map((t) => (
                <s-badge key={t.id} tone="neutral">
                  {t.name}
                </s-badge>
              ))}
            </s-stack>
          )}
        </s-stack>
      </s-section>

      {/* KPI bar --------------------------------------------------------- */}
      <s-section>
        <s-grid gridTemplateColumns="1fr 1fr 1fr 1fr" gap="base">
          <Stat label="Lifetime value" value={liveSpent} />
          <Stat label="Orders" value={String(liveOrderCount)} />
          <Stat label="Avg order value" value={insights ? formatMoney(insights.aov, currency) : "—"} />
          <Stat
            label="Last order"
            value={live?.lastOrderAt ? formatDate(live.lastOrderAt) : "—"}
            sub={
              insights?.daysSinceLastOrder != null
                ? `${formatDurationDays(insights.daysSinceLastOrder)} ago`
                : undefined
            }
          />
          <Stat
            label="Customer since"
            value={live ? formatDate(live.createdAt) : "—"}
            sub={insights?.tenureDays != null ? formatDurationDays(insights.tenureDays) : undefined}
          />
          <Stat
            label="Order frequency"
            value={insights?.avgDaysBetweenOrders != null ? `~${insights.avgDaysBetweenOrders} days` : "—"}
          />
          <Stat label="Email marketing" value={live?.emailMarketingState ?? "—"} />
          <Stat label="SMS marketing" value={live?.smsMarketingState ?? "—"} />
        </s-grid>
      </s-section>

      {/* Tabs ------------------------------------------------------------ */}
      <s-section>
        <s-stack direction="inline" gap="small-200">
          {TABS.map((t) => (
            <s-button
              key={t}
              variant={tab === t ? "primary" : "tertiary"}
              onClick={() => setTab(t)}
            >
              {t}
            </s-button>
          ))}
        </s-stack>
      </s-section>

      {/* SUMMARY --------------------------------------------------------- */}
      {tab === "Summary" && (
        <>
          {insights?.atRisk && (
            <s-banner tone="warning" heading="This customer may be at risk of churning">
              <s-paragraph>
                No order in {formatDurationDays(insights.daysSinceLastOrder)}, well beyond their
                usual ~{insights.avgDaysBetweenOrders}-day cadence. Consider a re-engagement
                message.
              </s-paragraph>
            </s-banner>
          )}

          {insights && insights.topProducts.length > 0 && (
            <s-section heading="Top products">
              <s-stack direction="block" gap="small-200">
                {insights.topProducts.map((p) => (
                  <s-stack key={p.title} direction="inline" gap="base" alignItems="center">
                    <s-text type="strong">{p.title}</s-text>
                    <s-text color="subdued">×{p.quantity}</s-text>
                  </s-stack>
                ))}
              </s-stack>
            </s-section>
          )}

          <s-section heading="Recent orders">
            {recentOrders.length === 0 ? (
              <s-paragraph color="subdued">No recent orders.</s-paragraph>
            ) : (
              <s-stack direction="block" gap="small-200">
                {recentOrders.map((o) => {
                  const oid = o.id.split("/").pop();
                  return (
                    <s-box key={o.id} padding="small-200" borderRadius="base" background="subdued">
                      <s-stack direction="inline" gap="base" alignItems="center">
                        <s-link href={`https://${data.shop}/admin/orders/${oid}`} target="_blank">
                          {o.name}
                        </s-link>
                        <s-badge tone={financialTone(o.displayFinancialStatus)}>
                          {o.displayFinancialStatus ?? "—"}
                        </s-badge>
                        <s-text color="subdued">{formatDate(o.createdAt)}</s-text>
                        <s-text type="strong">
                          {o.totalPriceSet
                            ? formatMoney(
                                Number(o.totalPriceSet.shopMoney.amount),
                                o.totalPriceSet.shopMoney.currencyCode,
                              )
                            : "—"}
                        </s-text>
                      </s-stack>
                    </s-box>
                  );
                })}
                <s-button variant="tertiary" onClick={() => setTab("Orders")}>
                  View all orders
                </s-button>
              </s-stack>
            )}
          </s-section>

          <s-section heading="Recent activity">
            {recentActivity.length === 0 ? (
              <s-paragraph color="subdued">No activity yet.</s-paragraph>
            ) : (
              <s-stack direction="block" gap="small-200">
                {recentActivity.map((item) => (
                  <s-stack key={item.id} direction="inline" gap="base" alignItems="center">
                    <s-icon
                      type={isActivityType(item.type) ? ACTIVITY_TYPE_META[item.type].icon : "info"}
                    />
                    <s-text type="strong">
                      {isActivityType(item.type) ? ACTIVITY_TYPE_META[item.type].label : "Activity"}
                    </s-text>
                    <s-text>{describeTimeline(item)}</s-text>
                    <s-text color="subdued">{formatDateTime(item.occurredAt)}</s-text>
                  </s-stack>
                ))}
                <s-button variant="tertiary" onClick={() => setTab("Activity")}>
                  View full timeline
                </s-button>
              </s-stack>
            )}
          </s-section>

          {openTasks.length > 0 && (
            <s-section heading="Open tasks">
              <s-stack direction="block" gap="small-200">
                {openTasks.map((t) => (
                  <s-stack key={t.id} direction="inline" gap="base" alignItems="center">
                    <TaskStatusBadge status={t.status} />
                    <s-text type="strong">{t.title}</s-text>
                    {t.dueAt ? <s-text color="subdued">Due {formatDate(t.dueAt)}</s-text> : null}
                  </s-stack>
                ))}
              </s-stack>
            </s-section>
          )}

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
        </>
      )}

      {/* ORDERS ---------------------------------------------------------- */}
      {tab === "Orders" && (
        <s-section heading="Order history">
          {allOrders.length === 0 ? (
            <s-paragraph color="subdued">
              No orders in the last 60 days. (Older orders require a broader Shopify scope — see
              DECISIONS.md.)
            </s-paragraph>
          ) : (
            <s-stack direction="block" gap="base">
              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header>Order</s-table-header>
                  <s-table-header>Date</s-table-header>
                  <s-table-header>Payment</s-table-header>
                  <s-table-header>Fulfillment</s-table-header>
                  <s-table-header>Items</s-table-header>
                  <s-table-header>Total</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {allOrders.map((o) => {
                    const oid = o.id.split("/").pop();
                    const itemCount = o.lineItems.reduce((n, li) => n + (li.quantity || 0), 0);
                    return (
                      <s-table-row key={o.id}>
                        <s-table-cell>
                          <s-link href={`https://${data.shop}/admin/orders/${oid}`} target="_blank">
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
                        <s-table-cell>{itemCount || "—"}</s-table-cell>
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
      )}

      {/* ACTIVITY -------------------------------------------------------- */}
      {tab === "Activity" && (
        <s-section heading="Activity timeline">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="small-200">
              {ACTIVITY_FILTERS.map((f) => (
                <s-button
                  key={f.id}
                  variant={activityFilter === f.id ? "primary" : "tertiary"}
                  onClick={() => setActivityFilter(f.id)}
                >
                  {f.label}
                </s-button>
              ))}
            </s-stack>
            {filteredTimeline.length === 0 ? (
              <s-paragraph color="subdued">No matching activity.</s-paragraph>
            ) : (
              <s-stack direction="block" gap="small-200">
                {filteredTimeline.map((item) => (
                  <s-box key={item.id} padding="small-200" borderRadius="base" background="subdued">
                    <s-stack direction="inline" gap="base" alignItems="start">
                      <s-icon
                        type={isActivityType(item.type) ? ACTIVITY_TYPE_META[item.type].icon : "info"}
                      />
                      <s-stack direction="block" gap="small-500">
                        <s-text type="strong">
                          {isActivityType(item.type)
                            ? ACTIVITY_TYPE_META[item.type].label
                            : "Activity"}
                        </s-text>
                        <s-text>{describeTimeline(item)}</s-text>
                      </s-stack>
                      <s-text color="subdued">{formatDateTime(item.occurredAt)}</s-text>
                    </s-stack>
                  </s-box>
                ))}
              </s-stack>
            )}
          </s-stack>
        </s-section>
      )}

      {/* NOTES & TASKS --------------------------------------------------- */}
      {tab === "Notes & Tasks" && (
        <>
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
                    <ConfirmAction
                      id={`confirm-del-note-${note.id}`}
                      triggerLabel="Delete note"
                      heading="Delete note?"
                      message="This note will be permanently removed."
                      confirmLabel="Delete note"
                      fields={{ _action: "deleteNote", noteId: note.id }}
                    />
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          </s-section>

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
        </>
      )}

      {/* DETAILS --------------------------------------------------------- */}
      {tab === "Details" && (
        <>
          <s-section heading="Profile">
            <s-stack direction="block" gap="small-200">
              <s-text>
                <s-text type="strong">Email: </s-text>
                {contact.email ?? "—"}
                {live?.verifiedEmail ? " (verified)" : ""}
              </s-text>
              <s-text>
                <s-text type="strong">Phone: </s-text>
                {contact.phone ?? "—"}
              </s-text>
              <s-text>
                <s-text type="strong">Email marketing: </s-text>
                {live?.emailMarketingState ?? "—"}
              </s-text>
              <s-text>
                <s-text type="strong">SMS marketing: </s-text>
                {live?.smsMarketingState ?? "—"}
              </s-text>
              {contact.source && (
                <s-text>
                  <s-text type="strong">Source: </s-text>
                  {contact.source}
                </s-text>
              )}
              <s-text>
                <s-text type="strong">Shopify ID: </s-text>
                {contact.shopifyCustomerId}
              </s-text>
              {live?.note && (
                <s-text>
                  <s-text type="strong">Shopify note: </s-text>
                  {live.note}
                </s-text>
              )}
            </s-stack>
          </s-section>

          {live?.defaultAddress?.formatted && (
            <s-section heading="Default address">
              <s-stack direction="block" gap="small-500">
                {live.defaultAddress.formatted.map((line, i) => (
                  <s-text key={i} color="subdued">
                    {line}
                  </s-text>
                ))}
              </s-stack>
            </s-section>
          )}

          {live && live.tags.length > 0 && (
            <s-section heading="Shopify tags">
              <s-stack direction="inline" gap="small-200">
                {live.tags.map((t) => (
                  <s-badge key={t} tone="neutral">
                    {t}
                  </s-badge>
                ))}
              </s-stack>
            </s-section>
          )}
        </>
      )}

      {/* Aside: management rail ------------------------------------------ */}
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
