import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { isValidCnpj, normalizeCnpj } from "../lib/validation/br-documents";
import { lookupCnpj } from "../lib/lookup/brasilapi.server";
import type { CnpjLookupResult, LookupResponse } from "../lib/lookup/types";

// Resource route: GET /app/api/cnpj?cnpj=... — proxies the BrasilAPI lookup
// server-side (the embedded admin's CSP blocks direct external fetches).
export const loader = async ({
  request,
}: LoaderFunctionArgs): Promise<LookupResponse<CnpjLookupResult>> => {
  await authenticate.admin(request);

  // Always reduce to bare digits before validating/fetching — BrasilAPI 404s on a
  // formatted CNPJ.
  const cnpj = normalizeCnpj(new URL(request.url).searchParams.get("cnpj") ?? "");
  if (!isValidCnpj(cnpj)) {
    return { ok: false, reason: "invalid", data: null };
  }

  try {
    const data = await lookupCnpj(cnpj);
    if (!data) return { ok: false, reason: "not_found", data: null };
    return { ok: true, reason: null, data };
  } catch {
    return { ok: false, reason: "error", data: null };
  }
};
