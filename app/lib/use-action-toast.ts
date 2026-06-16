import { useEffect, useRef } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

export interface ActionResult {
  ok: boolean;
  toast?: string;
}

/**
 * Show a Polaris toast for an action/fetcher result, exactly once per submission.
 *
 * Dedups on the result OBJECT REFERENCE (each completed submission yields a fresh object), not
 * on the toast string — so performing the same action twice in a row still confirms each time,
 * and coalescing multiple sources with `??` (which would mask a later source behind a stale,
 * still-truthy `.data`) is avoided by calling this once per source.
 */
export function useActionToast(result: ActionResult | undefined): void {
  const shopify = useAppBridge();
  const lastShown = useRef<ActionResult | null>(null);
  useEffect(() => {
    if (result && result !== lastShown.current && result.toast) {
      lastShown.current = result;
      shopify.toast.show(result.toast, result.ok ? {} : { isError: true });
    }
  }, [result, shopify]);
}
