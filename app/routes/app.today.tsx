import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useNavigate, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { staffIdFromSessionToken } from "../lib/staff.server";
import {
  getStaffProfile,
  setHomeLocation,
} from "../lib/crm/staff-profile.server";
import { groupTasks, listTasks } from "../lib/crm/tasks.server";
import { dateStringInTz } from "../lib/timezone";
import { displayName, formatDate, formatMoney } from "../lib/format";
import { StageBadge } from "../components/badges";
import { useActionToast } from "../lib/use-action-toast";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const shop = session.shop;
  const staffId = staffIdFromSessionToken(sessionToken);
  const url = new URL(request.url);
  const hasOverride = url.searchParams.has("location");
  const overrideLocationId = url.searchParams.get("location")?.trim() || null;

  const [locations, settings, profile] = await Promise.all([
    prisma.location.findMany({
      where: { shop, isActive: true },
      orderBy: { name: "asc" },
      select: { legacyId: true, name: true, city: true, provinceCode: true },
    }),
    prisma.shopSettings.findUnique({
      where: { shop },
      select: { ianaTimezone: true },
    }),
    staffId ? getStaffProfile(shop, staffId) : Promise.resolve(null),
  ]);

  const requestedLocationId = hasOverride
    ? overrideLocationId
    : profile?.homeLocationId ?? null;
  const selectedLocation =
    locations.find((location) => location.legacyId === requestedLocationId) ?? null;
  const timezone = settings?.ianaTimezone ?? null;
  const today = dateStringInTz(new Date(), timezone);

  if (!selectedLocation) {
    return {
      locations,
      selectedLocationId: null,
      selectedLocationName: null,
      staffAvailable: Boolean(staffId),
      timezone,
      today,
      visits: [],
      followUps: [],
    };
  }

  const [visits, tasks] = await Promise.all([
    prisma.visit.findMany({
      where: {
        shop,
        locationId: selectedLocation.legacyId,
        visitDate: today,
      },
      include: {
        contact: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            lifecycleStage: true,
          },
        },
      },
    }),
    staffId
      ? listTasks(shop, {
          status: "OPEN",
          assigneeStaffId: staffId,
          locationId: selectedLocation.legacyId,
        })
      : Promise.resolve([]),
  ]);

  const orderGids = visits.flatMap((visit) => (visit.orderGid ? [visit.orderGid] : []));
  const contactIds = visits.map((visit) => visit.contactId);
  const [orders, contactLocations] = await Promise.all([
    orderGids.length > 0
      ? prisma.processedOrder.findMany({
          where: { shop, orderGid: { in: orderGids } },
          select: {
            orderGid: true,
            occurredAt: true,
            total: true,
            currencyCode: true,
            orderName: true,
          },
        })
      : Promise.resolve([]),
    contactIds.length > 0
      ? prisma.contactLocation.findMany({
          where: {
            shop,
            locationId: selectedLocation.legacyId,
            contactId: { in: contactIds },
          },
          select: { contactId: true, ordersCount: true },
        })
      : Promise.resolve([]),
  ]);

  const ordersByGid = new Map(orders.map((order) => [order.orderGid, order]));
  const ordersCountByContact = new Map(
    contactLocations.map((row) => [row.contactId, row.ordersCount]),
  );
  const visitRows = visits
    .map((visit) => {
      const order = visit.orderGid ? ordersByGid.get(visit.orderGid) : undefined;
      return {
        id: visit.id,
        contactId: visit.contact.id,
        customerName: displayName(visit.contact.firstName, visit.contact.lastName),
        email: visit.contact.email,
        phone: visit.contact.phone,
        lifecycleStage: visit.contact.lifecycleStage,
        occurredAt: order?.occurredAt ?? visit.createdAt,
        total: order?.total ? Number(order.total) : null,
        currencyCode: order?.currencyCode ?? null,
        orderName: order?.orderName ?? null,
        firstVisitHere: ordersCountByContact.get(visit.contactId) === 1,
      };
    })
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

  const groups = groupTasks(tasks);
  const toFollowUp = (task: (typeof tasks)[number], overdue: boolean) => ({
    id: task.id,
    title: task.title,
    dueAt: task.dueAt,
    contactId: task.contactId,
    contactName: task.contact
      ? displayName(task.contact.firstName, task.contact.lastName)
      : null,
    overdue,
  });

  return {
    locations,
    selectedLocationId: selectedLocation.legacyId,
    selectedLocationName: selectedLocation.name,
    staffAvailable: Boolean(staffId),
    timezone,
    today,
    visits: visitRows,
    followUps: [
      ...groups.overdue.map((task) => toFollowUp(task, true)),
      ...groups.today.map((task) => toFollowUp(task, false)),
    ],
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const shop = session.shop;
  const staffId = staffIdFromSessionToken(sessionToken);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");

  try {
    if (intent !== "setLocation") {
      return { ok: false, toast: "Unknown action." };
    }

    const requestedLocationId = String(form.get("locationId") ?? "").trim();
    let locationId: string | null = null;
    if (requestedLocationId) {
      const location = await prisma.location.findFirst({
        where: { shop, legacyId: requestedLocationId, isActive: true },
        select: { legacyId: true },
      });
      if (!location) return { ok: false, toast: "Choose an active store." };
      locationId = location.legacyId;
    }

    if (staffId) await setHomeLocation(shop, staffId, locationId);
    return {
      ok: true,
      toast: staffId ? "Home store updated." : "Store selected for this view.",
      locationId,
      persisted: Boolean(staffId),
    };
  } catch (error) {
    return { ok: false, toast: error instanceof Error ? error.message : "Action failed." };
  }
};

export default function TodayPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [locationId, setLocationId] = useState(data.selectedLocationId ?? "");
  const switching = fetcher.state !== "idle";
  useActionToast(fetcher.data);

  useEffect(() => {
    setLocationId(data.selectedLocationId ?? "");
  }, [data.selectedLocationId]);

  useEffect(() => {
    const result = fetcher.data;
    if (
      fetcher.state !== "idle" ||
      !result?.ok ||
      !("locationId" in result) ||
      !("persisted" in result)
    ) {
      return;
    }
    const href =
      result.persisted || !result.locationId
        ? "/app/today"
        : `/app/today?location=${encodeURIComponent(result.locationId)}`;
    navigate(href, { replace: true });
  }, [fetcher.data, fetcher.state, navigate]);

  function chooseLocation(value: string) {
    setLocationId(value);
    fetcher.submit(
      { _action: "setLocation", locationId: value },
      { method: "post" },
    );
  }

  return (
    <s-page heading="Today">
      <s-section heading="Store">
        <s-stack direction="inline" gap="base" alignItems="end">
          <s-select
            label="Store"
            value={locationId}
            onChange={(event) =>
              chooseLocation((event.target as HTMLSelectElement | null)?.value ?? "")
            }
          >
            <s-option value="">Select a store</s-option>
            {data.locations.map((location) => (
              <s-option key={location.legacyId} value={location.legacyId}>
                {location.name}
              </s-option>
            ))}
          </s-select>
          {switching ? <s-spinner accessibilityLabel="Switching store" size="base" /> : null}
          {data.selectedLocationId ? (
            <s-badge tone="info">
              {data.visits.length} visit{data.visits.length === 1 ? "" : "s"} today
            </s-badge>
          ) : null}
        </s-stack>
        {!data.staffAvailable ? (
          <s-paragraph color="subdued">
            Staff identity is unavailable here. Your selection applies to this view but will not
            be saved as a home store.
          </s-paragraph>
        ) : null}
      </s-section>

      {data.locations.length === 0 ? (
        <s-section heading="No stores synced">
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">
              Store locations have not been synced from Shopify. Run a Shopify sync to load them.
            </s-paragraph>
            <s-button href="/app/contacts">Go to Contacts to resync</s-button>
          </s-stack>
        </s-section>
      ) : !data.selectedLocationId ? (
        <s-section heading="Choose a store">
          <s-paragraph color="subdued">
            Pick the store you are working in to see today&apos;s customer visits and follow-ups.
          </s-paragraph>
        </s-section>
      ) : (
        <>
          <s-section heading={`${data.selectedLocationName} visits`}>
            {data.visits.length === 0 ? (
              <s-paragraph color="subdued">
                Visits appear when a customer is attached to a POS sale at this store.
              </s-paragraph>
            ) : (
              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header>Time</s-table-header>
                  <s-table-header>Customer</s-table-header>
                  <s-table-header>Stage</s-table-header>
                  <s-table-header>Order</s-table-header>
                  <s-table-header>Total</s-table-header>
                  <s-table-header>Visit</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {data.visits.map((visit) => (
                    <s-table-row key={visit.id}>
                      <s-table-cell>
                        {new Intl.DateTimeFormat("en-US", {
                          hour: "numeric",
                          minute: "2-digit",
                          ...(data.timezone ? { timeZone: data.timezone } : {}),
                        }).format(new Date(visit.occurredAt))}
                      </s-table-cell>
                      <s-table-cell>
                        <s-stack direction="block" gap="small-500">
                          <s-link href={`/app/contacts/${visit.contactId}`}>
                            {visit.customerName}
                          </s-link>
                          <s-text color="subdued">
                            {visit.email ?? visit.phone ?? "No contact details"}
                          </s-text>
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        <StageBadge stage={visit.lifecycleStage} />
                      </s-table-cell>
                      <s-table-cell>{visit.orderName ?? "—"}</s-table-cell>
                      <s-table-cell>
                        {visit.total == null
                          ? "—"
                          : formatMoney(visit.total, visit.currencyCode)}
                      </s-table-cell>
                      <s-table-cell>
                        {visit.firstVisitHere ? (
                          <s-badge tone="success">First visit here</s-badge>
                        ) : (
                          "—"
                        )}
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}
          </s-section>

          <s-section heading="Open follow-ups for this store">
            {!data.staffAvailable ? (
              <s-paragraph color="subdued">
                Sign in through the embedded app to see follow-ups assigned to you.
              </s-paragraph>
            ) : data.followUps.length === 0 ? (
              <s-paragraph color="subdued">No assigned follow-ups are due or overdue.</s-paragraph>
            ) : (
              <s-stack direction="block" gap="small-200">
                {data.followUps.map((task) => (
                  <s-box key={task.id} padding="small-200" borderRadius="base" background="subdued">
                    <s-stack direction="inline" gap="base" alignItems="center">
                      <s-badge tone={task.overdue ? "critical" : "info"}>
                        {task.overdue ? "Overdue" : "Due today"}
                      </s-badge>
                      <s-text type="strong">{task.title}</s-text>
                      {task.dueAt ? <s-text color="subdued">Due {formatDate(task.dueAt)}</s-text> : null}
                      {task.contactId && task.contactName ? (
                        <s-link href={`/app/contacts/${task.contactId}`}>{task.contactName}</s-link>
                      ) : null}
                    </s-stack>
                  </s-box>
                ))}
              </s-stack>
            )}
          </s-section>
        </>
      )}
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
