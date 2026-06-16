import { useEffect, useRef } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useFetcher, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  listContacts,
  resolveOwnedContactIds,
  setLifecycleStage,
} from "../lib/crm/contacts.server";
import { addTagToContacts, listTags } from "../lib/crm/tags.server";
import { backfillContacts } from "../lib/crm/mirror.server";
import { createSegment, deleteSegment, listSegments } from "../lib/crm/segments.server";
import {
  contactListParamsToSearch,
  hasActiveFilter,
  parseContactListParams,
  paramsToFilter,
} from "../lib/crm/list-params";
import {
  LIFECYCLE_STAGES,
  LIFECYCLE_STAGE_META,
  SPEND_TIERS,
} from "../lib/crm/constants";
import type { ContactSortField } from "../lib/crm/types";
import { displayName, formatDate, formatMoney } from "../lib/format";
import { StageBadge } from "../components/badges";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const params = parseContactListParams(url.searchParams);

  const [list, tags, segments] = await Promise.all([
    listContacts(shop, params),
    listTags(shop),
    listSegments(shop),
  ]);

  return {
    params,
    filterActive: hasActiveFilter(params),
    rows: list.rows.map((c) => ({
      id: c.id,
      name: displayName(c.firstName, c.lastName),
      email: c.email,
      phone: c.phone,
      stage: c.lifecycleStage,
      tags: c.tags.map((t) => t.tag.name),
      ordersCount: c.ordersCount,
      amountSpent: c.amountSpent,
      currencyCode: c.currencyCode,
      lastOrderAt: c.lastOrderAt,
    })),
    total: list.total,
    page: list.page,
    pageCount: list.pageCount,
    pageSize: list.pageSize,
    tags: tags.map((t) => ({ id: t.id, name: t.name, count: t._count.contacts })),
    segments: segments.map((s) => ({ id: s.id, name: s.name, criteria: s.criteria })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");

  try {
    switch (intent) {
      case "resync": {
        const result = await backfillContacts(admin, shop);
        return { ok: true, toast: `Synced ${result.processed} customers from Shopify.` };
      }
      case "bulkStage": {
        const ids = form.getAll("contactId").map(String);
        const stage = String(form.get("stage") ?? "");
        const owned = await resolveOwnedContactIds(shop, ids);
        for (const id of owned) await setLifecycleStage(shop, id, stage);
        return { ok: true, toast: `Updated stage for ${owned.length} contact(s).` };
      }
      case "bulkTag": {
        const ids = form.getAll("contactId").map(String);
        const name = String(form.get("tagName") ?? "").trim();
        if (!name) return { ok: false, toast: "Enter a tag name." };
        const n = await addTagToContacts(shop, ids, name);
        return { ok: true, toast: `Tagged ${n} contact(s) with “${name}”.` };
      }
      case "saveSegment": {
        const name = String(form.get("segmentName") ?? "").trim();
        if (!name) return { ok: false, toast: "Enter a segment name." };
        await createSegment(shop, name, {
          search: String(form.get("q") ?? ""),
          stages: form.getAll("stage").map(String) as never,
          tagIds: form.getAll("tag").map(String),
          spendTiers: form.getAll("spend").map(String),
        });
        return { ok: true, toast: `Saved segment “${name}”.` };
      }
      case "deleteSegment": {
        await deleteSegment(shop, String(form.get("segmentId") ?? ""));
        return { ok: true, toast: "Segment deleted." };
      }
      default:
        return { ok: false, toast: "Unknown action." };
    }
  } catch (error) {
    return { ok: false, toast: error instanceof Error ? error.message : "Action failed." };
  }
};

const SORT_LABELS: Record<ContactSortField, string> = {
  name: "Name",
  email: "Email",
  createdAt: "Created",
  updatedAt: "Updated",
  amountSpent: "Spent",
  ordersCount: "Orders",
  lastOrderAt: "Last order",
  lifecycleStage: "Stage",
};

export default function ContactsList() {
  const data = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const bulkFetcher = useFetcher<typeof action>();
  const resyncFetcher = useFetcher<typeof action>();
  const segmentFetcher = useFetcher<typeof action>();
  const bulkFormRef = useRef<HTMLFormElement | null>(null);
  const navigate = useNavigate();

  // Submit the bulk form (which contains the selected-row checkboxes) for a chosen action.
  function submitBulk(action: string) {
    const form = bulkFormRef.current;
    if (!form) return;
    const fd = new FormData(form);
    fd.set("_action", action);
    bulkFetcher.submit(fd, { method: "post" });
  }

  // Navigate to the bulk-message composer with the checked contact ids.
  function messageSelected() {
    const form = bulkFormRef.current;
    if (!form) return;
    const ids = new FormData(form).getAll("contactId").map(String);
    if (ids.length === 0) {
      shopify.toast.show("Select at least one contact first.", { isError: true });
      return;
    }
    const sp = new URLSearchParams();
    ids.forEach((id) => sp.append("id", id));
    navigate(`/app/contacts/bulk?${sp.toString()}`);
  }

  // Surface action results as toasts.
  const lastToast = useRef<string | null>(null);
  useEffect(() => {
    const result =
      bulkFetcher.data ?? resyncFetcher.data ?? segmentFetcher.data ?? null;
    if (result?.toast && result.toast !== lastToast.current) {
      lastToast.current = result.toast;
      shopify.toast.show(result.toast, result.ok ? {} : { isError: true });
    }
  }, [bulkFetcher.data, resyncFetcher.data, segmentFetcher.data, shopify]);

  const { params } = data;

  // Build a sort link that toggles direction on the active column.
  function sortHref(field: ContactSortField): string {
    const next = contactListParamsToSearch({
      ...params,
      sortField: field,
      sortDir: params.sortField === field && params.sortDir === "asc" ? "desc" : "asc",
      page: 1,
    });
    return `?${next.toString()}`;
  }
  function sortIndicator(field: ContactSortField): string {
    if (params.sortField !== field) return "";
    return params.sortDir === "asc" ? " ↑" : " ↓";
  }

  function pageHref(page: number): string {
    const sp = contactListParamsToSearch({ ...params, page });
    return `?${sp.toString()}`;
  }

  const resyncing = resyncFetcher.state !== "idle";

  return (
    <s-page heading="Contacts">
      <resyncFetcher.Form method="post" slot="primary-action">
        <input type="hidden" name="_action" value="resync" />
        <s-button type="submit" variant="primary" {...(resyncing ? { loading: true } : {})}>
          Sync from Shopify
        </s-button>
      </resyncFetcher.Form>

      {/* Filters --------------------------------------------------------- */}
      <s-section heading="Filters">
        <Form method="get">
          <s-stack direction="block" gap="base">
            <s-search-field
              label="Search"
              name="q"
              value={params.search ?? ""}
              placeholder="Search name, email or phone"
            />

            <s-stack direction="block" gap="small-200">
              <s-text type="strong">Lifecycle stage</s-text>
              <s-stack direction="inline" gap="base">
                {LIFECYCLE_STAGES.map((stage) => (
                  <s-checkbox
                    key={stage}
                    name="stage"
                    value={stage}
                    label={LIFECYCLE_STAGE_META[stage].label}
                    {...(params.stages?.includes(stage) ? { checked: true } : {})}
                  />
                ))}
              </s-stack>
            </s-stack>

            <s-stack direction="block" gap="small-200">
              <s-text type="strong">Spend</s-text>
              <s-stack direction="inline" gap="base">
                {SPEND_TIERS.map((tier) => (
                  <s-checkbox
                    key={tier.id}
                    name="spend"
                    value={tier.id}
                    label={tier.label}
                    {...(params.spendTiers?.includes(tier.id) ? { checked: true } : {})}
                  />
                ))}
              </s-stack>
            </s-stack>

            {data.tags.length > 0 && (
              <s-stack direction="block" gap="small-200">
                <s-text type="strong">Tags</s-text>
                <s-stack direction="inline" gap="base">
                  {data.tags.map((tag) => (
                    <s-checkbox
                      key={tag.id}
                      name="tag"
                      value={tag.id}
                      label={`${tag.name} (${tag.count})`}
                      {...(params.tagIds?.includes(tag.id) ? { checked: true } : {})}
                    />
                  ))}
                </s-stack>
              </s-stack>
            )}

            {/* keep current sort when applying filters */}
            <input type="hidden" name="sort" value={params.sortField} />
            <input type="hidden" name="dir" value={params.sortDir} />

            <s-stack direction="inline" gap="base">
              <s-button type="submit" variant="primary">
                Apply filters
              </s-button>
              {data.filterActive && (
                <s-button href="/app/contacts" variant="tertiary">
                  Clear all
                </s-button>
              )}
            </s-stack>
          </s-stack>
        </Form>

        {/* Save the current filter as a reusable segment. */}
        {data.filterActive && (
          <Form method="post">
            <input type="hidden" name="_action" value="saveSegment" />
            <input type="hidden" name="q" value={params.search ?? ""} />
            {(params.stages ?? []).map((s) => (
              <input key={s} type="hidden" name="stage" value={s} />
            ))}
            {(params.tagIds ?? []).map((t) => (
              <input key={t} type="hidden" name="tag" value={t} />
            ))}
            {(params.spendTiers ?? []).map((s) => (
              <input key={s} type="hidden" name="spend" value={s} />
            ))}
            <s-stack direction="inline" gap="base" alignItems="end">
              <s-text-field name="segmentName" label="Save current filter as segment" placeholder="Segment name" />
              <s-button type="submit" variant="secondary">
                Save segment
              </s-button>
            </s-stack>
          </Form>
        )}

        {data.segments.length > 0 && (
          <s-stack direction="block" gap="small-200">
            <s-text type="strong">Saved segments</s-text>
            <s-stack direction="inline" gap="base">
              {data.segments.map((seg) => {
                const sp = new URLSearchParams(filterCriteriaToSearch(seg.criteria));
                return (
                  <s-stack key={seg.id} direction="inline" gap="small-500" alignItems="center">
                    <s-button href={`/app/contacts?${sp.toString()}`} variant="tertiary">
                      {seg.name}
                    </s-button>
                    <s-button
                      href={`/app/contacts/bulk?segment=${seg.id}`}
                      variant="tertiary"
                      icon="email"
                      accessibilityLabel={`Message segment ${seg.name}`}
                    />
                    <segmentFetcher.Form method="post">
                      <input type="hidden" name="_action" value="deleteSegment" />
                      <input type="hidden" name="segmentId" value={seg.id} />
                      <s-button
                        type="submit"
                        variant="tertiary"
                        tone="critical"
                        icon="delete"
                        accessibilityLabel={`Delete segment ${seg.name}`}
                      />
                    </segmentFetcher.Form>
                  </s-stack>
                );
              })}
            </s-stack>
          </s-stack>
        )}
      </s-section>

      {/* Results --------------------------------------------------------- */}
      <s-section heading={`${data.total} contact${data.total === 1 ? "" : "s"}`}>
        {data.rows.length === 0 ? (
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">
              {data.filterActive
                ? "No contacts match your filters."
                : "No contacts yet. Sync your existing Shopify customers to get started."}
            </s-paragraph>
            {data.filterActive ? (
              <s-button href="/app/contacts">Clear filters</s-button>
            ) : (
              <resyncFetcher.Form method="post">
                <input type="hidden" name="_action" value="resync" />
                <s-button type="submit" variant="primary" {...(resyncing ? { loading: true } : {})}>
                  Sync from Shopify
                </s-button>
              </resyncFetcher.Form>
            )}
          </s-stack>
        ) : (
          <bulkFetcher.Form method="post" ref={bulkFormRef}>
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header>Select</s-table-header>
                <s-table-header>
                  <s-link href={sortHref("name")}>Name{sortIndicator("name")}</s-link>
                </s-table-header>
                <s-table-header>
                  <s-link href={sortHref("email")}>Email{sortIndicator("email")}</s-link>
                </s-table-header>
                <s-table-header>
                  <s-link href={sortHref("lifecycleStage")}>
                    Stage{sortIndicator("lifecycleStage")}
                  </s-link>
                </s-table-header>
                <s-table-header>Tags</s-table-header>
                <s-table-header>
                  <s-link href={sortHref("ordersCount")}>
                    Orders{sortIndicator("ordersCount")}
                  </s-link>
                </s-table-header>
                <s-table-header>
                  <s-link href={sortHref("amountSpent")}>
                    Spent{sortIndicator("amountSpent")}
                  </s-link>
                </s-table-header>
                <s-table-header>
                  <s-link href={sortHref("lastOrderAt")}>
                    Last order{sortIndicator("lastOrderAt")}
                  </s-link>
                </s-table-header>
              </s-table-header-row>
              <s-table-body>
                {data.rows.map((r) => (
                  <s-table-row key={r.id}>
                    <s-table-cell>
                      <s-checkbox
                        name="contactId"
                        value={r.id}
                        label={`Select ${r.name}`}
                        labelAccessibilityVisibility="exclusive"
                      />
                    </s-table-cell>
                    <s-table-cell>
                      <s-link href={`/app/contacts/${r.id}`}>{r.name}</s-link>
                    </s-table-cell>
                    <s-table-cell>{r.email ?? "—"}</s-table-cell>
                    <s-table-cell>
                      <StageBadge stage={r.stage} />
                    </s-table-cell>
                    <s-table-cell>
                      {r.tags.length > 0 ? r.tags.slice(0, 3).join(", ") : "—"}
                    </s-table-cell>
                    <s-table-cell>{r.ordersCount}</s-table-cell>
                    <s-table-cell>{formatMoney(r.amountSpent, r.currencyCode)}</s-table-cell>
                    <s-table-cell>{r.lastOrderAt ? formatDate(r.lastOrderAt) : "—"}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>

            {/* Bulk actions operate on the checked rows above. */}
            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="small-200">
                <s-text type="strong">Bulk actions for selected contacts</s-text>
                <s-stack direction="inline" gap="base" alignItems="end">
                  <s-select name="stage" label="Set stage">
                    {LIFECYCLE_STAGES.map((stage) => (
                      <s-option key={stage} value={stage}>
                        {LIFECYCLE_STAGE_META[stage].label}
                      </s-option>
                    ))}
                  </s-select>
                  <s-button onClick={() => submitBulk("bulkStage")}>Apply stage</s-button>
                </s-stack>
                <s-stack direction="inline" gap="base" alignItems="end">
                  <s-text-field name="tagName" label="Add tag" placeholder="e.g. Wholesale" />
                  <s-button onClick={() => submitBulk("bulkTag")}>Add tag</s-button>
                </s-stack>
                <s-button variant="primary" onClick={messageSelected}>
                  Message selected
                </s-button>
              </s-stack>
            </s-box>
          </bulkFetcher.Form>
        )}

        {/* Pagination */}
        {data.pageCount > 1 && (
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
        )}
      </s-section>

    </s-page>
  );
}

/** Turn a stored segment criteria JSON string into a list query string. */
function filterCriteriaToSearch(criteria: string): string {
  try {
    const f = JSON.parse(criteria) as {
      search?: string;
      stages?: string[];
      tagIds?: string[];
      spendTiers?: string[];
    };
    const sp = new URLSearchParams();
    if (f.search) sp.set("q", f.search);
    for (const s of f.stages ?? []) sp.append("stage", s);
    for (const t of f.tagIds ?? []) sp.append("tag", t);
    for (const s of f.spendTiers ?? []) sp.append("spend", s);
    return sp.toString();
  } catch {
    return "";
  }
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
