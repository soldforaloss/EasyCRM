import { useCallback, useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useFetcher, useLoaderData, useRouteError } from "react-router";
import type { Prisma } from "@prisma/client";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { displayName, formatMoney } from "../lib/format";
import { logOutreach } from "../lib/crm/outreach.server";
import { getStaffProfile } from "../lib/crm/staff-profile.server";
import { staffIdFromSessionToken } from "../lib/staff.server";
import { dateStringInTz } from "../lib/timezone";
import {
  orderWindowCutoff,
  summarizeLineItems,
  type OrderWindowDays,
} from "../lib/orders";
import { useActionToast } from "../lib/use-action-toast";

const PAGE_SIZE = 25;
const SOURCES = ["pos", "online", "all"] as const;
type OrderSource = (typeof SOURCES)[number];
type OutreachMethod = "OUTREACH_CALL" | "OUTREACH_IN_PERSON" | "OUTREACH_TEXT";

function orderSource(value: string | null): OrderSource {
  return SOURCES.includes(value as OrderSource)
    ? (value as OrderSource)
    : "pos";
}

function orderDays(value: string | null): OrderWindowDays {
  return value === "1" || value === "30" || value === "all" ? value : "7";
}

function requestedPage(value: string | null): number {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function orderTimeLabel(
  value: Date | null,
  timezone: string | null,
  now: Date,
): string {
  if (!value) return "—";
  const orderDate = dateStringInTz(value, timezone);
  const today = dateStringInTz(now, timezone);
  const [orderYear, orderMonth, orderDay] = orderDate.split("-").map(Number);
  const [todayYear, todayMonth, todayDay] = today.split("-").map(Number);
  const dayDifference = Math.round(
    (Date.UTC(todayYear, todayMonth - 1, todayDay) -
      Date.UTC(orderYear, orderMonth - 1, orderDay)) /
      86_400_000,
  );
  const dayLabel =
    dayDifference === 0
      ? "Today"
      : dayDifference === 1
        ? "Yesterday"
        : new Intl.DateTimeFormat("en-US", {
            month: "short",
            day: "numeric",
            ...(timezone ? { timeZone: timezone } : {}),
          }).format(value);
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    ...(timezone ? { timeZone: timezone } : {}),
  }).format(value);
  return `${dayLabel}, ${time}`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const shop = session.shop;
  const staffId = staffIdFromSessionToken(sessionToken);
  const url = new URL(request.url);
  const source = orderSource(url.searchParams.get("source"));
  const days = orderDays(url.searchParams.get("days"));
  const wantedPage = requestedPage(url.searchParams.get("page"));

  const [locations, settings, profile] = await Promise.all([
    prisma.location.findMany({
      where: { shop },
      orderBy: { name: "asc" },
      select: { legacyId: true, name: true, isActive: true },
    }),
    prisma.shopSettings.findUnique({
      where: { shop },
      select: { ianaTimezone: true },
    }),
    staffId ? getStaffProfile(shop, staffId) : Promise.resolve(null),
  ]);
  const locationIds = new Set(locations.map((location) => location.legacyId));
  const locationParam = url.searchParams.get("location");
  const location =
    locationParam === null
      ? profile?.homeLocationId && locationIds.has(profile.homeLocationId)
        ? profile.homeLocationId
        : "all"
      : locationParam !== "all" && locationIds.has(locationParam)
        ? locationParam
        : "all";
  const timezone = settings?.ianaTimezone ?? null;
  const cutoff = orderWindowCutoff(new Date(), days, timezone);
  const where: Prisma.ProcessedOrderWhereInput = {
    shop,
    ...(location === "all" ? {} : { locationId: location }),
    ...(cutoff ? { occurredAt: { gte: cutoff } } : {}),
    ...(source === "pos"
      ? { sourceName: "pos" }
      : source === "online"
        ? { OR: [{ sourceName: { not: "pos" } }, { sourceName: null }] }
        : {}),
  };
  const total = await prisma.processedOrder.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(wantedPage, pageCount);
  const now = new Date();
  const orders = await prisma.processedOrder.findMany({
    where,
    orderBy: { occurredAt: "desc" },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    select: {
      id: true,
      contactId: true,
      orderName: true,
      total: true,
      currencyCode: true,
      occurredAt: true,
      sourceName: true,
      locationId: true,
      lineItems: true,
      contact: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
        },
      },
    },
  });

  return {
    filters: { location, source, days },
    locations,
    locationNames: Object.fromEntries(
      locations.map((shopLocation) => [
        shopLocation.legacyId,
        shopLocation.name,
      ]),
    ),
    timezone,
    total,
    page,
    pageCount,
    orders: orders.map((order) => {
      const contact = order.contact as typeof order.contact | null;
      const totalValue = order.total === null ? null : Number(order.total);
      return {
        id: order.id,
        orderName: order.orderName ?? "—",
        time: orderTimeLabel(order.occurredAt, timezone, now),
        contact: contact
          ? {
              id: contact.id,
              name: displayName(contact.firstName, contact.lastName),
              detail: contact.email ?? contact.phone ?? "No contact details",
            }
          : null,
        items: summarizeLineItems(order.lineItems),
        total:
          totalValue !== null && Number.isFinite(totalValue)
            ? totalValue
            : null,
        currencyCode: order.currencyCode,
        locationId: order.locationId,
        isPos: order.sourceName === "pos",
      };
    }),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");

  try {
    if (intent !== "logOutreach")
      return { ok: false, toast: "Unknown action." };
    await logOutreach(session.shop, String(form.get("contactId") ?? ""), {
      type: String(form.get("type") ?? ""),
      note: String(form.get("note") ?? ""),
      staffId: staffIdFromSessionToken(sessionToken),
    });
    return { ok: true, toast: "Outreach logged." };
  } catch (error) {
    return {
      ok: false,
      toast: error instanceof Error ? error.message : "Action failed.",
    };
  }
};

function OutreachControl({
  contactId,
  expanded,
  onExpand,
  onCollapse,
}: {
  contactId: string;
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
}) {
  const fetcher = useFetcher<typeof action>();
  const [method, setMethod] = useState<OutreachMethod>("OUTREACH_CALL");
  const [note, setNote] = useState("");
  const busy = fetcher.state !== "idle";
  useActionToast(fetcher.data);

  useEffect(() => {
    if (fetcher.data?.ok) {
      setNote("");
      onCollapse();
    }
  }, [fetcher.data, onCollapse]);

  function chooseMethod(value: string) {
    if (
      value === "OUTREACH_CALL" ||
      value === "OUTREACH_IN_PERSON" ||
      value === "OUTREACH_TEXT"
    ) {
      setMethod(value);
    }
  }

  function submit() {
    fetcher.submit(
      {
        _action: "logOutreach",
        contactId,
        type: method,
        note: note.trim(),
      },
      { method: "post" },
    );
  }

  if (!expanded) return <s-button onClick={onExpand}>Log outreach</s-button>;

  return (
    <s-stack direction="block" gap="small-200">
      <s-select
        label="Method"
        value={method}
        onChange={(event) =>
          chooseMethod((event.target as HTMLSelectElement | null)?.value ?? "")
        }
      >
        <s-option value="OUTREACH_CALL">Call</s-option>
        <s-option value="OUTREACH_IN_PERSON">In person</s-option>
        <s-option value="OUTREACH_TEXT">Text</s-option>
      </s-select>
      <s-text-field
        label="Note"
        value={note}
        placeholder="What did you discuss?"
        onInput={(event) =>
          setNote((event.target as HTMLInputElement | null)?.value ?? "")
        }
      />
      <s-stack direction="inline" gap="small-200">
        <s-button
          variant="primary"
          onClick={submit}
          {...(busy ? { loading: true, disabled: true } : {})}
        >
          Log
        </s-button>
        <s-button onClick={onCollapse} {...(busy ? { disabled: true } : {})}>
          Cancel
        </s-button>
      </s-stack>
    </s-stack>
  );
}

export default function OrdersPage() {
  const data = useLoaderData<typeof loader>();
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const collapseOutreach = useCallback(() => setExpandedOrderId(null), []);

  function pageHref(page: number): string {
    const search = new URLSearchParams({
      location: data.filters.location,
      source: data.filters.source,
      days: data.filters.days,
      page: String(page),
    });
    return `?${search.toString()}`;
  }

  return (
    <s-page heading="Orders">
      <s-section heading="Filters">
        <Form method="get">
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-select
              name="location"
              label="Store"
              value={data.filters.location}
            >
              <s-option value="all">All stores</s-option>
              {data.locations.map((location) => (
                <s-option key={location.legacyId} value={location.legacyId}>
                  {location.name}
                  {location.isActive ? "" : " (inactive)"}
                </s-option>
              ))}
            </s-select>
            <s-select name="source" label="Source" value={data.filters.source}>
              <s-option value="pos">POS</s-option>
              <s-option value="online">Online</s-option>
              <s-option value="all">All</s-option>
            </s-select>
            <s-select name="days" label="Date range" value={data.filters.days}>
              <s-option value="1">Today</s-option>
              <s-option value="7">Last 7 days</s-option>
              <s-option value="30">Last 30 days</s-option>
              <s-option value="all">All time</s-option>
            </s-select>
            <s-button type="submit" variant="primary">
              Apply filters
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading={`${data.total} order${data.total === 1 ? "" : "s"}`}>
        {data.orders.length === 0 ? (
          <s-paragraph color="subdued">
            No orders match these filters.
          </s-paragraph>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header>Time</s-table-header>
              <s-table-header>Order</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Items</s-table-header>
              <s-table-header>Total</s-table-header>
              <s-table-header>Store</s-table-header>
              <s-table-header>Source</s-table-header>
              <s-table-header>Outreach</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.orders.map((order) => (
                <s-table-row key={order.id}>
                  <s-table-cell>{order.time}</s-table-cell>
                  <s-table-cell>{order.orderName}</s-table-cell>
                  <s-table-cell>
                    {order.contact ? (
                      <s-stack direction="block" gap="small-500">
                        <s-link href={`/app/contacts/${order.contact.id}`}>
                          {order.contact.name}
                        </s-link>
                        <s-text color="subdued">{order.contact.detail}</s-text>
                      </s-stack>
                    ) : (
                      <s-text color="subdued">Guest</s-text>
                    )}
                  </s-table-cell>
                  <s-table-cell>{order.items}</s-table-cell>
                  <s-table-cell>
                    {order.total === null
                      ? "—"
                      : formatMoney(order.total, order.currencyCode)}
                  </s-table-cell>
                  <s-table-cell>
                    {order.locationId
                      ? (data.locationNames[order.locationId] ??
                        order.locationId)
                      : "—"}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={order.isPos ? "info" : "success"}>
                      {order.isPos ? "POS" : "Online"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {order.contact ? (
                      <OutreachControl
                        contactId={order.contact.id}
                        expanded={expandedOrderId === order.id}
                        onExpand={() => setExpandedOrderId(order.id)}
                        onCollapse={collapseOutreach}
                      />
                    ) : (
                      "—"
                    )}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}

        {data.pageCount > 1 ? (
          <s-stack direction="inline" gap="base" alignItems="center">
            {data.page > 1 ? (
              <s-button href={pageHref(data.page - 1)} variant="tertiary">
                Previous
              </s-button>
            ) : (
              <s-button variant="tertiary" disabled>
                Previous
              </s-button>
            )}
            <s-text color="subdued">
              Page {data.page} of {data.pageCount}
            </s-text>
            {data.page < data.pageCount ? (
              <s-button href={pageHref(data.page + 1)} variant="tertiary">
                Next
              </s-button>
            ) : (
              <s-button variant="tertiary" disabled>
                Next
              </s-button>
            )}
          </s-stack>
        ) : null}
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
