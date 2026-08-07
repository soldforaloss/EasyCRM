import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { StageBadge } from "../components/badges";
import { getCrmSettings } from "../lib/crm/settings.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return getCrmSettings(session.shop);
};

export default function SettingsPage() {
  const settings = useLoaderData<typeof loader>();

  return (
    <s-page heading="Settings">
      <s-section heading="Store timezone">
        <s-stack direction="block" gap="small-200">
          <s-text type="strong">
            {settings.ianaTimezone ?? "Not synced yet"}
          </s-text>
          <s-paragraph color="subdued">
            The timezone is synced from Shopify and determines each store-local
            day used for visits.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Lifecycle stages">
        <s-stack direction="inline" gap="small-200">
          {settings.lifecycleStages.map((stage) => (
            <StageBadge key={stage} stage={stage} />
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
