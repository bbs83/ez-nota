import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  getActiveEmitenteWithSettings,
  getOrCreateShop,
} from "../lib/shop.server";
import {
  CSOSN_OPTIONS,
  CSOSN_VALUES,
  ORIGEM_OPTIONS,
  ORIGEM_VALUES,
} from "../lib/fiscal/fiscal-codes";
import { onlyDigits } from "../lib/validation/br-documents";
import { WcSelect, WcTextField } from "../components/wc-fields";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);
  const emitente = await getActiveEmitenteWithSettings(shop.id);
  if (!emitente || !emitente.fiscalSettings) return redirect("/app/onboarding");
  const s = emitente.fiscalSettings;
  return {
    defaultNcm: s.defaultNcm ?? "",
    defaultCfop: s.defaultCfop,
    defaultCsosn: s.defaultCsosn,
    defaultOrigem: s.defaultOrigem,
  };
};

// ---------------------------------------------------------------------------
// Action: atualiza os defaults da cascata no FiscalSettings do emitente ACTIVE.
// Validação server-side é a fonte de verdade. NCM vazio = sem default (null).
// ---------------------------------------------------------------------------
type ActionData = { ok: true } | { ok: false; fieldErrors: Record<string, string> };

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionData> => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);
  const emitente = await getActiveEmitenteWithSettings(shop.id);
  if (!emitente || !emitente.fiscalSettings) {
    return { ok: false, fieldErrors: { _form: "Configure a empresa primeiro." } };
  }
  const settings = emitente.fiscalSettings;

  const form = await request.formData();
  const defaultNcm = onlyDigits(String(form.get("defaultNcm") ?? ""));
  const defaultCfop = onlyDigits(String(form.get("defaultCfop") ?? ""));
  const defaultCsosn = String(form.get("defaultCsosn") ?? "").trim();
  const defaultOrigem = String(form.get("defaultOrigem") ?? "").trim();

  const fieldErrors: Record<string, string> = {};
  if (defaultNcm && defaultNcm.length !== 8) {
    fieldErrors.defaultNcm = "NCM deve ter 8 dígitos (ou vazio).";
  }
  if (defaultCfop.length !== 4) fieldErrors.defaultCfop = "CFOP deve ter 4 dígitos.";
  if (!CSOSN_VALUES.has(defaultCsosn)) fieldErrors.defaultCsosn = "CSOSN inválido.";
  if (!ORIGEM_VALUES.has(defaultOrigem)) fieldErrors.defaultOrigem = "Origem inválida.";
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  await prisma.fiscalSettings.update({
    where: { id: settings.id },
    data: {
      defaultNcm: defaultNcm || null, // vazio = sem default
      defaultCfop,
      defaultCsosn,
      defaultOrigem,
    },
  });
  return { ok: true };
};

export default function ConfiguracoesFiscais() {
  const loaderData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [ncm, setNcm] = useState(loaderData.defaultNcm);
  const [cfop, setCfop] = useState(loaderData.defaultCfop);
  const [csosn, setCsosn] = useState(loaderData.defaultCsosn);
  const [origem, setOrigem] = useState(loaderData.defaultOrigem);

  // Toast de sucesso (uma vez por submission).
  const processedResult = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || !fetcher.data.ok) return;
    if (processedResult.current === fetcher.data) return;
    processedResult.current = fetcher.data;
    shopify.toast.show("Configurações fiscais salvas");
  }, [fetcher.state, fetcher.data, shopify]);

  const serverErrors =
    fetcher.data && !fetcher.data.ok ? fetcher.data.fieldErrors : {};
  const ncmValid = ncm === "" || ncm.length === 8;
  const cfopValid = cfop.length === 4;
  const busy = fetcher.state !== "idle";
  const saveDisabled = !ncmValid || !cfopValid || busy;

  const save = () => {
    const fd = new FormData();
    fd.append("defaultNcm", ncm);
    fd.append("defaultCfop", cfop);
    fd.append("defaultCsosn", csosn);
    fd.append("defaultOrigem", origem);
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <s-page heading="Configurações fiscais">
      <s-section heading="Padrões de emissão">
        <s-paragraph>
          Valores usados quando um produto não tem mapeamento específico nem HS
          code do Shopify. Veja o que cada produto resolve no Catálogo fiscal.
        </s-paragraph>

        {serverErrors._form ? (
          <s-banner tone="critical">{serverErrors._form}</s-banner>
        ) : null}

        <WcTextField
          label="NCM padrão (opcional)"
          placeholder="00000000"
          value={ncm}
          format={(v) => onlyDigits(v).slice(0, 8)}
          onValueChange={setNcm}
          error={
            ncm.length > 0 && !ncmValid
              ? "NCM deve ter 8 dígitos."
              : serverErrors.defaultNcm
          }
          details="8 dígitos. Vazio = sem default (produtos sem NCM ficam 'Falta NCM')."
        />
        <WcTextField
          label="CFOP padrão"
          placeholder="5102"
          value={cfop}
          format={(v) => onlyDigits(v).slice(0, 4)}
          onValueChange={setCfop}
          error={
            cfop.length > 0 && !cfopValid
              ? "CFOP deve ter 4 dígitos."
              : serverErrors.defaultCfop
          }
          details="4 dígitos. Obrigatório."
        />
        <WcSelect
          label="CSOSN padrão"
          value={csosn}
          onValueChange={setCsosn}
          error={serverErrors.defaultCsosn}
        >
          {CSOSN_OPTIONS.map((o) => (
            <s-option key={o.value} value={o.value}>
              {o.label}
            </s-option>
          ))}
        </WcSelect>
        <WcSelect
          label="Origem padrão"
          value={origem}
          onValueChange={setOrigem}
          error={serverErrors.defaultOrigem}
        >
          {ORIGEM_OPTIONS.map((o) => (
            <s-option key={o.value} value={o.value}>
              {o.label}
            </s-option>
          ))}
        </WcSelect>

        <s-button
          variant="primary"
          onClick={save}
          {...(saveDisabled ? { disabled: true } : {})}
          {...(busy ? { loading: true } : {})}
        >
          Salvar
        </s-button>
      </s-section>
    </s-page>
  );
}
