import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { countContacts, countContactsSince } from "../lib/crm/contacts.server";
import { countOpenTasks, groupTasks, listTasks } from "../lib/crm/tasks.server";
import { getBrevoStatus } from "../lib/crm/settings.server";
import { listRecentActivity } from "../lib/crm/activity.server";
import { ACTIVITY_TYPE_META, isActivityType } from "../lib/crm/constants";
import { displayName, formatDate, formatRelativeDay } from "../lib/format";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const since = new Date(Date.now() - 30 * 86_400_000);

  const [totalContacts, newContacts, openTasks, brevo, recent, openTaskList] =
    await Promise.all([
      countContacts(shop),
      countContactsSince(shop, since),
      countOpenTasks(shop),
      getBrevoStatus(shop),
      listRecentActivity(shop, 8),
      listTasks(shop, { status: "OPEN" }),
    ]);

  const grouped = groupTasks(openTaskList);
  const tasksDue = [
    ...grouped.overdue.map((t) => ({ ...t, overdue: true })),
    ...grouped.today.map((t) => ({ ...t, overdue: false })),
  ].slice(0, 6);

  return {
    totalContacts,
    newContacts,
    openTasks,
    brevoConnected: brevo.connected,
    recent: recent.map((a) => ({
      id: a.id,
      type: a.type,
      occurredAt: a.occurredAt,
      contactId: a.contactId,
      contactName: displayName(a.contact?.firstName, a.contact?.lastName, "A contact"),
    })),
    tasksDue: tasksDue.map((t) => ({
      id: t.id,
      title: t.title,
      dueAt: t.dueAt,
      overdue: t.overdue,
      contactId: t.contactId,
    })),
  };
};

function MetricTile({
  label,
  value,
  href,
}: {
  label: string;
  value: number | string;
  href?: string;
}) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
      <s-stack direction="block" gap="small-300">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{String(value)}</s-heading>
        {href ? (
          <s-link href={href}>View</s-link>
        ) : (
          <s-text color="subdued"> </s-text>
        )}
      </s-stack>
    </s-box>
  );
}

function activityLabel(type: string): string {
  return isActivityType(type) ? ACTIVITY_TYPE_META[type].label : "Activity";
}

export default function Dashboard() {
  const { totalContacts, newContacts, openTasks, brevoConnected, recent, tasksDue } =
    useLoaderData<typeof loader>();

  return (
    <s-page heading="Easy CRM">
      <s-button slot="primary-action" href="/app/contacts" variant="primary">
        View contacts
      </s-button>

      {!brevoConnected && (
        <s-banner tone="info" heading="Connect Brevo to start messaging">
          <s-paragraph>
            Add your Brevo API key in Settings to send email and SMS to your customers.
          </s-paragraph>
          <s-button slot="primary-action" href="/app/settings">
            Go to Settings
          </s-button>
        </s-banner>
      )}

      <s-section heading="Overview">
        <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
          <MetricTile label="Total contacts" value={totalContacts} href="/app/contacts" />
          <MetricTile label="New in last 30 days" value={newContacts} />
          <MetricTile label="Open tasks" value={openTasks} href="/app/tasks" />
        </s-grid>
      </s-section>

      <s-section heading="Recent activity">
        {recent.length === 0 ? (
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">
              No activity yet. As customers are synced, place orders, and you log notes or send
              messages, the latest events will appear here.
            </s-paragraph>
            <s-button href="/app/contacts">Browse contacts</s-button>
          </s-stack>
        ) : (
          <s-stack direction="block" gap="small-200">
            {recent.map((a) => (
              <s-box
                key={a.id}
                padding="small-200"
                borderRadius="base"
                background="subdued"
              >
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-icon type={isActivityType(a.type) ? ACTIVITY_TYPE_META[a.type].icon : "info"} />
                  <s-stack direction="block" gap="small-500">
                    <s-text type="strong">{activityLabel(a.type)}</s-text>
                    <s-link href={`/app/contacts/${a.contactId}`}>{a.contactName}</s-link>
                  </s-stack>
                  <s-text color="subdued">{formatRelativeDay(a.occurredAt)}</s-text>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Tasks due">
        {tasksDue.length === 0 ? (
          <s-paragraph color="subdued">
            Nothing due right now. <s-link href="/app/tasks">View all tasks</s-link>.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="small-200">
            {tasksDue.map((t) => (
              <s-box key={t.id} padding="small-200" borderRadius="base" background="subdued">
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-badge tone={t.overdue ? "critical" : "caution"}>
                    {t.overdue ? "Overdue" : "Today"}
                  </s-badge>
                  <s-stack direction="block" gap="small-500">
                    {t.contactId ? (
                      <s-link href={`/app/contacts/${t.contactId}`}>{t.title}</s-link>
                    ) : (
                      <s-text type="strong">{t.title}</s-text>
                    )}
                    {t.dueAt && <s-text color="subdued">Due {formatDate(t.dueAt)}</s-text>}
                  </s-stack>
                </s-stack>
              </s-box>
            ))}
            <s-link href="/app/tasks">View all tasks</s-link>
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="Quick links">
        <s-stack direction="block" gap="small-200">
          <s-link href="/app/contacts">Contacts</s-link>
          <s-link href="/app/tasks">Tasks</s-link>
          <s-link href="/app/templates">Message templates</s-link>
          <s-link href="/app/settings">Settings &amp; Brevo</s-link>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
