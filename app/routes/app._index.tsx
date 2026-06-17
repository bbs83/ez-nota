import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getActiveEmitente, getOrCreateShop } from "../lib/shop.server";

// Home. If the shop has not completed onboarding (no ACTIVE Emitente), send them
// to the wizard. Otherwise show the (placeholder) dashboard.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);
  const emitente = await getActiveEmitente(shop.id);
  if (!emitente) return redirect("/app/onboarding");

  return {
    razaoSocial: emitente.razaoSocial,
    cnpj: emitente.cnpj,
    municipio: emitente.municipio,
    uf: emitente.uf,
  };
};

export default function Index() {
  const { razaoSocial, cnpj, municipio, uf } = useLoaderData<typeof loader>();

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
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
