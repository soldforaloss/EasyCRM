import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
    const { payload, session, topic, shop } = await authenticate.webhook(request);
    console.log(`Received ${topic} webhook for ${shop}`);

    // Guard the shape: a malformed/empty payload must be acknowledged, not throw a 500 (retry loop).
    const current = Array.isArray((payload as { current?: unknown }).current)
      ? (payload as { current: string[] }).current
      : [];
    if (session) {
        await db.session.update({   
            where: {
                id: session.id
            },
            data: {
                scope: current.toString(),
            },
        });
    }
    return new Response();
};
