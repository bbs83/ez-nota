import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { isValidCep, normalizeCep } from "../lib/validation/br-documents";
import { lookupCep } from "../lib/lookup/viacep.server";
import type { CepLookupResult, LookupResponse } from "../lib/lookup/types";

// Resource route: GET /app/api/cep?cep=... — proxies the ViaCEP lookup server-side.
export const loader = async ({
  request,
}: LoaderFunctionArgs): Promise<LookupResponse<CepLookupResult>> => {
  await authenticate.admin(request);

  // Always reduce to bare digits before validating/fetching.
  const cep = normalizeCep(new URL(request.url).searchParams.get("cep") ?? "");
  if (!isValidCep(cep)) {
    return { ok: false, reason: "invalid", data: null };
  }

  try {
    const data = await lookupCep(cep);
    if (!data) return { ok: false, reason: "not_found", data: null };
    return { ok: true, reason: null, data };
  } catch {
    return { ok: false, reason: "error", data: null };
  }
};
