import { useEffect, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  ShouldRevalidateFunction,
} from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  getActiveEmitenteWithSettings,
  getOrCreateShop,
} from "../lib/shop.server";
import { fetchCatalogPage } from "../lib/fiscal/catalog.server";
import {
  resolveVariantFiscalConfig,
  type VariantFiscalConfig,
} from "../lib/fiscal/variant-fiscal-config.server";
import {
  CSOSN_OPTIONS,
  CSOSN_VALUES,
  ORIGEM_OPTIONS,
  ORIGEM_VALUES,
} from "../lib/fiscal/fiscal-codes";
import { onlyDigits } from "../lib/validation/br-documents";
import { WcSelect, WcTextField } from "../components/wc-fields";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin, redirect } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);
  const emitente = await getActiveEmitenteWithSettings(shop.id);
  if (!emitente || !emitente.fiscalSettings) return redirect("/app/onboarding");

  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const after = url.searchParams.get("after") ?? undefined;

  const page = await fetchCatalogPage(admin, {
    shopId: shop.id,
    defaults: emitente.fiscalSettings,
    query: q || undefined,
    after,
    pageSize: 50,
  });

  return {
    q,
    onLaterPage: !!after,
    rows: page.rows,
    hasNextPage: page.hasNextPage,
    endCursor: page.endCursor,
  };
};

// The mapping mutation only changes one local row — do NOT re-run the loader
// (which would re-fetch all products from Shopify, ~5s). The action returns the
// re-resolved row and the client patches it. GET navigations (busca/paginação)
// still revalidate normally.
export const shouldRevalidate: ShouldRevalidateFunction = ({
  formMethod,
  defaultShouldRevalidate,
}) => (formMethod === "POST" ? false : defaultShouldRevalidate);

// ---------------------------------------------------------------------------
// Action: upsert/delete do ProductFiscalMapping (escopado por shopId) + RE-RESOLVE
// a variante via o núcleo compartilhado e devolve o resultado (sem re-buscar Shopify).
// ---------------------------------------------------------------------------
type MappingValues = {
  ncm: string | null;
  cfop: string | null;
  csosn: string | null;
  origem: string | null;
};
type ActionData =
  | {
      ok: true;
      intent: "upsert" | "delete";
      variantId: string;
      fiscal: VariantFiscalConfig;
      mapping: MappingValues | null;
    }
  | { ok: false; fieldErrors: Record<string, string> };

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
  const intent = String(form.get("intent") ?? "");
  const shopifyVariantId = String(form.get("shopifyVariantId") ?? "").trim();
  const hsCodeBr = String(form.get("hsCodeBr") ?? "").trim() || null;
  if (!shopifyVariantId) {
    return { ok: false, fieldErrors: { _form: "Variante inválida." } };
  }

  if (intent === "delete") {
    await prisma.productFiscalMapping.deleteMany({
      where: { shopId: shop.id, shopifyVariantId },
    });
    const fiscal = resolveVariantFiscalConfig({
      hsCodeBr,
      mapping: null,
      defaults: settings,
    });
    return { ok: true, intent: "delete", variantId: shopifyVariantId, fiscal, mapping: null };
  }

  const ncm = onlyDigits(String(form.get("ncm") ?? ""));
  const cfopRaw = String(form.get("cfop") ?? "").trim();
  const cfop = onlyDigits(cfopRaw);
  const csosn = String(form.get("csosn") ?? "").trim();
  const origem = String(form.get("origem") ?? "").trim();

  const fieldErrors: Record<string, string> = {};
  if (ncm.length !== 8) fieldErrors.ncm = "NCM deve ter 8 dígitos.";
  if (cfopRaw && cfop.length !== 4) fieldErrors.cfop = "CFOP deve ter 4 dígitos.";
  if (csosn && !CSOSN_VALUES.has(csosn)) fieldErrors.csosn = "CSOSN inválido.";
  if (origem && !ORIGEM_VALUES.has(origem)) fieldErrors.origem = "Origem inválida.";
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  // ncm is validated non-null here; let TS infer ncm: string (Prisma/resolver want non-null).
  const mapping = {
    ncm,
    cfop: cfop || null,
    csosn: csosn || null,
    origem: origem || null,
  };
  await prisma.productFiscalMapping.upsert({
    where: { shopId_shopifyVariantId: { shopId: shop.id, shopifyVariantId } },
    update: mapping,
    create: { shopId: shop.id, shopifyVariantId, ...mapping },
  });
  const fiscal = resolveVariantFiscalConfig({ hsCodeBr, mapping, defaults: settings });
  return { ok: true, intent: "upsert", variantId: shopifyVariantId, fiscal, mapping };
};

const SOURCE_BADGE: Record<
  string,
  { label: string; tone: "info" | "success" | "critical" | "neutral" }
> = {
  shopify_hs: { label: "HS Shopify", tone: "info" },
  mapping: { label: "Mapeamento", tone: "success" },
  default: { label: "Padrão", tone: "neutral" },
  none: { label: "Falta NCM", tone: "critical" },
};

type CatalogRowData = ReturnType<
  typeof useLoaderData<typeof loader>
>["rows"][number];

interface EditingState {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  hsCodeBr: string | null;
  hasMapping: boolean;
}

export default function Catalogo() {
  const loaderData = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  // Rows live in state so the mutation can patch a single row without re-fetching
  // Shopify. Re-sync only when the loader actually re-runs (busca/paginação).
  const [rows, setRows] = useState(loaderData.rows);
  useEffect(() => setRows(loaderData.rows), [loaderData.rows]);

  const [search, setSearch] = useState(loaderData.q);
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [ncm, setNcm] = useState("");
  const [cfop, setCfop] = useState("");
  const [csosn, setCsosn] = useState("");
  const [origem, setOrigem] = useState("");

  // On confirmed success: patch the row, close the modal, toast. On error: keep
  // the modal open with the field errors (do nothing here). The ref guard makes
  // this run once per submission (in case useAppBridge isn't referentially stable).
  const processedResult = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || !fetcher.data.ok) return;
    if (processedResult.current === fetcher.data) return;
    processedResult.current = fetcher.data;
    const data = fetcher.data;
    setRows((prev) =>
      prev.map((r) =>
        r.variantId === data.variantId
          ? { ...r, fiscal: data.fiscal, mapping: data.mapping }
          : r,
      ),
    );
    shopify.modal.hide("edit-mapping");
    shopify.toast.show(
      data.intent === "delete" ? "Mapeamento removido" : "NCM salvo",
    );
    setEditing(null);
  }, [fetcher.state, fetcher.data, shopify]);

  const attentionCount = rows.filter(
    (r) => r.fiscal.ncm.source === "none",
  ).length;
  const visible = showAll
    ? rows
    : rows.filter((r) => r.fiscal.ncm.source === "none");

  const runSearch = () =>
    navigate(`/app/catalogo?q=${encodeURIComponent(search.trim())}`);
  const goNext = () => {
    if (loaderData.hasNextPage && loaderData.endCursor) {
      navigate(
        `/app/catalogo?q=${encodeURIComponent(loaderData.q)}&after=${encodeURIComponent(loaderData.endCursor)}`,
      );
    }
  };
  const goStart = () =>
    navigate(`/app/catalogo?q=${encodeURIComponent(loaderData.q)}`);

  const openEdit = (row: CatalogRowData) => {
    if (!row.variantId) return;
    setEditing({
      variantId: row.variantId,
      productTitle: row.productTitle,
      variantTitle: row.variantTitle,
      hsCodeBr: row.hsCodeBr,
      hasMapping: !!row.mapping,
    });
    setNcm(row.mapping?.ncm ?? row.fiscal.ncm.value ?? "");
    setCfop(row.mapping?.cfop ?? "");
    setCsosn(row.mapping?.csosn ?? "");
    setOrigem(row.mapping?.origem ?? "");
    shopify.modal.show("edit-mapping");
  };

  const busy = fetcher.state !== "idle";
  const save = () => {
    if (!editing) return;
    const fd = new FormData();
    fd.append("intent", "upsert");
    fd.append("shopifyVariantId", editing.variantId);
    fd.append("hsCodeBr", editing.hsCodeBr ?? "");
    fd.append("ncm", ncm);
    fd.append("cfop", cfop);
    fd.append("csosn", csosn);
    fd.append("origem", origem);
    fetcher.submit(fd, { method: "post" });
  };
  const removeMapping = () => {
    if (!editing) return;
    const fd = new FormData();
    fd.append("intent", "delete");
    fd.append("shopifyVariantId", editing.variantId);
    fd.append("hsCodeBr", editing.hsCodeBr ?? "");
    fetcher.submit(fd, { method: "post" });
  };
  const cancel = () => {
    shopify.modal.hide("edit-mapping");
    setEditing(null);
  };

  const serverErrors =
    fetcher.data && !fetcher.data.ok ? fetcher.data.fieldErrors : {};
  const ncmValid = ncm.length === 8;
  const cfopValid = cfop === "" || cfop.length === 4;
  const saveDisabled = !ncmValid || !cfopValid || busy;

  return (
    <s-page heading="Catálogo fiscal">
      <s-section heading="Produtos e NCM resolvido">
        <s-paragraph>
          O NCM que cada variante resolve hoje e de onde vem. Edite para definir um
          NCM (e, opcionalmente, CFOP/CSOSN/origem) por produto.
        </s-paragraph>

        <s-stack direction="inline" gap="base" alignItems="end">
          <WcTextField
            label="Buscar produto"
            placeholder="Nome do produto"
            value={search}
            onValueChange={setSearch}
            onCommit={runSearch}
          />
          <s-button variant="primary" onClick={runSearch}>
            Buscar
          </s-button>
        </s-stack>

        <s-stack direction="inline" gap="base">
          <s-button
            {...(!showAll ? { variant: "primary" } : {})}
            onClick={() => setShowAll(false)}
          >
            Precisa de atenção ({attentionCount})
          </s-button>
          <s-button
            {...(showAll ? { variant: "primary" } : {})}
            onClick={() => setShowAll(true)}
          >
            Todos ({rows.length})
          </s-button>
        </s-stack>

        {visible.length === 0 ? (
          <s-paragraph>
            {rows.length === 0
              ? "Nenhum produto encontrado."
              : "Nenhuma variante desta página precisa de atenção."}
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="small-300">
            {visible.map((r, index) => (
              <CatalogRow
                key={r.variantId ?? `row-${index}`}
                row={r}
                onEdit={openEdit}
              />
            ))}
          </s-stack>
        )}

        <s-stack direction="inline" gap="base">
          {loaderData.onLaterPage ? (
            <s-button onClick={goStart}>Início</s-button>
          ) : null}
          {loaderData.hasNextPage ? (
            <s-button onClick={goNext}>Próxima página</s-button>
          ) : null}
        </s-stack>
      </s-section>

      <s-modal id="edit-mapping" heading="Editar configuração fiscal">
        {editing ? (
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              {editing.productTitle}
              {editing.variantTitle && editing.variantTitle !== "Default Title"
                ? ` — ${editing.variantTitle}`
                : ""}
            </s-text>
            {serverErrors._form ? (
              <s-banner tone="critical">{serverErrors._form}</s-banner>
            ) : null}
            <WcTextField
              label="NCM"
              placeholder="00000000"
              value={ncm}
              format={(v) => onlyDigits(v).slice(0, 8)}
              onValueChange={setNcm}
              error={
                ncm.length > 0 && !ncmValid
                  ? "NCM deve ter 8 dígitos."
                  : serverErrors.ncm
              }
              details="8 dígitos. Obrigatório."
            />
            <WcTextField
              label="CFOP (opcional)"
              placeholder="ex.: 5102"
              value={cfop}
              format={(v) => onlyDigits(v).slice(0, 4)}
              onValueChange={setCfop}
              error={
                cfop.length > 0 && !cfopValid
                  ? "CFOP deve ter 4 dígitos."
                  : serverErrors.cfop
              }
              details="4 dígitos. Vazio = usa o padrão."
            />
            <WcSelect
              label="CSOSN (opcional)"
              value={csosn}
              onValueChange={setCsosn}
              error={serverErrors.csosn}
              details="Vazio = usa o padrão."
            >
              <s-option value="">(usar padrão)</s-option>
              {CSOSN_OPTIONS.map((o) => (
                <s-option key={o.value} value={o.value}>
                  {o.label}
                </s-option>
              ))}
            </WcSelect>
            <WcSelect
              label="Origem (opcional)"
              value={origem}
              onValueChange={setOrigem}
              error={serverErrors.origem}
              details="Vazio = usa o padrão."
            >
              <s-option value="">(usar padrão)</s-option>
              {ORIGEM_OPTIONS.map((o) => (
                <s-option key={o.value} value={o.value}>
                  {o.label}
                </s-option>
              ))}
            </WcSelect>
            {editing.hasMapping ? (
              <s-button
                variant="tertiary"
                tone="critical"
                onClick={removeMapping}
                {...(busy ? { disabled: true } : {})}
              >
                Remover mapeamento (voltar ao padrão)
              </s-button>
            ) : null}
          </s-stack>
        ) : null}
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={save}
          {...(saveDisabled ? { disabled: true } : {})}
          {...(busy ? { loading: true } : {})}
        >
          Salvar
        </s-button>
        <s-button slot="secondary-actions" onClick={cancel}>
          Cancelar
        </s-button>
      </s-modal>
    </s-page>
  );
}

function CatalogRow({
  row,
  onEdit,
}: {
  row: CatalogRowData;
  onEdit: (row: CatalogRowData) => void;
}) {
  const badge = SOURCE_BADGE[row.fiscal.ncm.source] ?? SOURCE_BADGE.none;
  const variantSuffix =
    row.variantTitle && row.variantTitle !== "Default Title"
      ? ` — ${row.variantTitle}`
      : "";

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="inline" gap="base" alignItems="center">
        <s-stack direction="block" gap="small-500">
          <s-text type="strong">
            {row.productTitle}
            {variantSuffix}
          </s-text>
          <s-text color="subdued">
            {row.sku ? `SKU ${row.sku} · ` : ""}NCM {row.fiscal.ncm.value || "—"}
          </s-text>
        </s-stack>
        <s-badge tone={badge.tone}>{badge.label}</s-badge>
        {row.variantId ? (
          <s-button onClick={() => onEdit(row)}>Editar</s-button>
        ) : null}
      </s-stack>
    </s-box>
  );
}
