import { useEffect, useRef } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getActiveEmitente, getOrCreateShop } from "../lib/shop.server";
import { reconcilePendingInvoices } from "../lib/invoice-resolver.server";

// Home. If the shop has not completed onboarding (no ACTIVE Emitente), send them
// to the wizard. Otherwise show the (placeholder) dashboard + a manual trigger to
// reconcile notes stuck in PROCESSING (test scaffold; o job agendado vem no deploy).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);
  const emitente = await getActiveEmitente(shop.id);
  if (!emitente) return redirect("/app/onboarding");

  // status literal "PROCESSING" (sem importar valores do @prisma/client na rota).
  const processando = await prisma.invoice.count({
    where: { shopId: shop.id, status: "PROCESSING" },
  });

  return {
    razaoSocial: emitente.razaoSocial,
    cnpj: emitente.cnpj,
    municipio: emitente.municipio,
    uf: emitente.uf,
    processando,
  };
};

// Action: varre as notas em PROCESSING do shop e resolve cada uma via o adapter
// (getInvoiceStatus). Disparo manual — sem cron. Retorna o resumo para o toast.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);
  const summary = await reconcilePendingInvoices(shop.id);
  return { ok: true as const, summary };
};

export default function Index() {
  const { razaoSocial, cnpj, municipio, uf, processando } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  // Toast com o resumo da varredura (uma vez por submission).
  const processedResult = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data?.ok) return;
    if (processedResult.current === fetcher.data) return;
    processedResult.current = fetcher.data;
    const s = fetcher.data.summary;
    shopify.toast.show(
      `Verificação concluída: ${s.resolvidas} autorizada(s), ${s.rejeitadas} rejeitada(s), ` +
        `${s.aindaProcessando} ainda processando, ${s.erros} erro(s).`,
    );
  }, [fetcher.state, fetcher.data, shopify]);

  const busy = fetcher.state !== "idle";

  return (
    <s-page heading="EZ Nota">
      <s-section heading="Empresa configurada">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            <s-text type="strong">{razaoSocial}</s-text>
          </s-paragraph>
          <s-paragraph>
            CNPJ {cnpj} · {municipio}/{uf}
          </s-paragraph>
          <s-paragraph>
            Sua identidade fiscal está pronta. A emissão automática de notas será
            ativada nos próximos passos do app.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Notas em processamento">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            {processando === 0
              ? "Nenhuma nota aguardando autorização da SEFAZ."
              : `${processando} nota(s) aguardando autorização da SEFAZ.`}
          </s-paragraph>
          <s-button
            onClick={() => fetcher.submit({}, { method: "post" })}
            {...(busy ? { loading: true } : {})}
          >
            Verificar status das notas em processamento
          </s-button>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
