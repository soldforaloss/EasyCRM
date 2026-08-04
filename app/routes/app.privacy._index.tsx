/**
 * Privacy requests — GDPR/CCPA `customers/data_request` exports awaiting delivery.
 *
 * Shopify forwards the request but provides no callback, so the merchant has to send the data to
 * the customer themselves (within 30 days). This screen is where they get it. See DECISIONS.md §14.
 */

import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getDataRequest,
  listDataRequests,
  resolveDataRequest,
} from "../lib/crm/compliance.server";
import { staffIdFromSessionToken } from "../lib/staff.server";
import { useActionToast } from "../lib/use-action-toast";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);

  // `?download=<id>` streams the stored export as a JSON attachment.
  const downloadId = url.searchParams.get("download");
  if (downloadId) {
    const found = await getDataRequest(session.shop, downloadId);
    if (!found) throw new Response("Not found", { status: 404 });
    const customerId = found.shopifyCustomerId.split("/").pop() ?? found.id;
    return new Response(found.payload, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="data-request-${customerId}.json"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const requests = await listDataRequests(session.shop);
  return {
    requests: requests.map((r) => ({
      id: r.id,
      customerId: r.shopifyCustomerId.split("/").pop() ?? r.shopifyCustomerId,
      customerEmail: r.customerEmail,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const form = await request.formData();
  if (String(form.get("_action")) !== "resolve") {
    return { ok: false, toast: "Unknown action." };
  }
  const id = String(form.get("id") ?? "");
  if (!id) return { ok: false, toast: "Missing request id." };
  await resolveDataRequest(session.shop, id, staffIdFromSessionToken(sessionToken));
  return { ok: true, toast: "Marked as fulfilled." };
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function PrivacyRequests() {
  const { requests } = useLoaderData<typeof loader>();
  useActionToast(useActionData<typeof action>());

  const open = requests.filter((r) => r.status === "OPEN");

  return (
    <s-page heading="Privacy requests">
      <s-section heading="Customer data requests">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            When a customer asks Shopify for their data, the request appears here. Download the
            export, send it to the customer, then mark it fulfilled. Regulations generally require
            this within 30 days.
          </s-paragraph>

          {requests.length === 0 ? (
            <s-paragraph color="subdued">No data requests have been received.</s-paragraph>
          ) : (
            <>
              {open.length > 0 ? (
                <s-banner tone="warning">
                  <s-paragraph>
                    {open.length} request{open.length === 1 ? "" : "s"} awaiting fulfilment.
                  </s-paragraph>
                </s-banner>
              ) : null}

              <s-table>
                <s-table-header-row>
                  <s-table-header>Customer</s-table-header>
                  <s-table-header>Received</s-table-header>
                  <s-table-header>Status</s-table-header>
                  <s-table-header>Actions</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {requests.map((r) => (
                    <s-table-row key={r.id}>
                      <s-table-cell>
                        {r.customerEmail ?? `Customer ${r.customerId}`}
                      </s-table-cell>
                      <s-table-cell>{formatDate(r.createdAt)}</s-table-cell>
                      <s-table-cell>
                        <s-badge tone={r.status === "OPEN" ? "warning" : "success"}>
                          {r.status === "OPEN" ? "Awaiting" : "Fulfilled"}
                        </s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        <s-stack direction="inline" gap="small-200">
                          <s-link href={`/app/privacy?download=${r.id}`}>Download</s-link>
                          {r.status === "OPEN" ? (
                            <Form method="post">
                              <input type="hidden" name="_action" value="resolve" />
                              <input type="hidden" name="id" value={r.id} />
                              <s-button type="submit" variant="tertiary">
                                Mark fulfilled
                              </s-button>
                            </Form>
                          ) : null}
                        </s-stack>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            </>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
