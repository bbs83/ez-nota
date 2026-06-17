import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  useActionData,
  useFetcher,
  useNavigation,
  useSubmit,
} from "react-router";
import {
  Ambiente,
  CertificateStatus,
  EmitenteStatus,
  RegimeTributario,
  TipoDocumento,
} from "@prisma/client";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getActiveEmitente, getOrCreateShop } from "../lib/shop.server";
import { getFiscalEngine } from "../lib/fiscal";
import { extractCertificateMetadata } from "../lib/certificate.server";
import {
  isValidCep,
  isValidCnpj,
  isValidEmail,
  maskCep,
  maskCnpj,
  maskPhone,
  normalizeCep,
  normalizeCnpj,
  onlyDigits,
} from "../lib/validation/br-documents";
import type {
  CepLookupResult,
  CnpjLookupResult,
  LookupResponse,
} from "../lib/lookup/types";

// ---------------------------------------------------------------------------
// Loader: gate the wizard. If onboarding already produced an ACTIVE Emitente,
// send the merchant to the home page instead.
// ---------------------------------------------------------------------------
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);
  const active = await getActiveEmitente(shop.id);
  if (active) return redirect("/app");
  return null;
};

// ---------------------------------------------------------------------------
// Action: final submit. Validates server-side (source of truth), forwards the
// certificate to the fiscal engine through the adapter, and persists
// Emitente + FiscalSettings + Certificate (metadata only) atomically.
// The .pfx bytes and password live in memory for this request only.
// ---------------------------------------------------------------------------
type ActionResult = {
  ok: false;
  formError: string | null;
  fieldErrors: Record<string, string>;
};

function coerceEnum<T extends Record<string, string>>(
  enumObj: T,
  value: string,
  fallback: T[keyof T],
): T[keyof T] {
  return (Object.values(enumObj) as string[]).includes(value)
    ? (value as T[keyof T])
    : fallback;
}

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionResult | Response> => {
  const { session, redirect } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);

  const form = await request.formData();
  const get = (key: string) => ((form.get(key) as string | null) ?? "").trim();

  // Identifiers/contact are normalized to bare digits server-side (the client
  // sends masked values for display).
  const cnpj = normalizeCnpj(get("cnpj"));
  const razaoSocial = get("razaoSocial");
  const nomeFantasia = get("nomeFantasia");
  const inscricaoEstadual = get("inscricaoEstadual");
  const inscricaoMunicipal = get("inscricaoMunicipal");
  const regimeTributario = coerceEnum(
    RegimeTributario,
    get("regimeTributario"),
    RegimeTributario.SIMPLES_NACIONAL,
  );
  const logradouro = get("logradouro");
  const numero = get("numero");
  const complemento = get("complemento");
  const bairro = get("bairro");
  const codigoMunicipioIbge = get("codigoMunicipioIbge");
  const municipio = get("municipio");
  const uf = get("uf").toUpperCase();
  const cep = normalizeCep(get("cep"));
  const telefone = onlyDigits(get("telefone"));
  const email = get("email");
  const ambiente = coerceEnum(Ambiente, get("ambiente"), Ambiente.HOMOLOGACAO);
  const tipoDocumento = coerceEnum(
    TipoDocumento,
    get("tipoDocumento"),
    TipoDocumento.NFE,
  );
  // Fiscal numbering must be >= 1; the server is the source of truth (plain
  // parseInt lets negatives like "-5" through). (M3)
  const serie = Math.max(1, parseInt(get("serie") || "1", 10) || 1);
  const proximoNumero = Math.max(
    1,
    parseInt(get("proximoNumero") || "1", 10) || 1,
  );
  const naturezaOperacao = get("naturezaOperacao") || "Venda de mercadoria";
  const certPassword = get("certPassword");
  const certificate = form.get("certificate");

  const fieldErrors: Record<string, string> = {};
  if (!isValidCnpj(cnpj)) fieldErrors.cnpj = "CNPJ inválido.";
  if (!razaoSocial) fieldErrors.razaoSocial = "Informe a razão social.";
  if (!inscricaoEstadual)
    fieldErrors.inscricaoEstadual = "Informe a inscrição estadual.";
  if (!logradouro) fieldErrors.logradouro = "Informe o logradouro.";
  if (!numero) fieldErrors.numero = "Informe o número.";
  if (!bairro) fieldErrors.bairro = "Informe o bairro.";
  if (!municipio) fieldErrors.municipio = "Informe o município.";
  if (!UF_SET.has(uf)) fieldErrors.uf = "UF inválida.";
  if (!isValidCep(cep)) fieldErrors.cep = "CEP inválido.";
  if (codigoMunicipioIbge.length < 7)
    fieldErrors.codigoMunicipioIbge = "Código IBGE do município inválido.";
  if (email && !isValidEmail(email)) fieldErrors.email = "E-mail inválido.";
  // A1 certificates are only a few KB; cap the upload before buffering it. (M1)
  const MAX_CERT_BYTES = 100 * 1024;
  if (!(certificate instanceof File) || certificate.size === 0) {
    fieldErrors.certificate = "Envie o certificado A1 (.pfx/.p12).";
  } else if (certificate.size > MAX_CERT_BYTES) {
    fieldErrors.certificate =
      "Certificado muito grande (máx. 100 KB para um A1).";
  }
  if (!certPassword)
    fieldErrors.certPassword = "Informe a senha do certificado.";

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, formError: null, fieldErrors };
  }

  // In-memory only — never persisted (CLAUDE.md decision #2).
  const certBuffer = Buffer.from(await (certificate as File).arrayBuffer());

  let companyRef: string | null = null;
  let engineFailed = false;
  try {
    const result = await getFiscalEngine().registerCompany(
      {
        cnpj,
        razaoSocial,
        nomeFantasia: nomeFantasia || null,
        inscricaoEstadual,
        inscricaoMunicipal: inscricaoMunicipal || null,
        regimeTributario,
        endereco: {
          logradouro,
          numero,
          complemento: complemento || null,
          bairro,
          codigoMunicipioIbge,
          municipio,
          uf,
          cep,
        },
        telefone: telefone || null,
        email: email || null,
        ambiente,
      },
      certBuffer,
      certPassword,
    );
    companyRef = result.companyRef;
  } catch {
    // Don't log the cert/password. Persist anyway so the merchant can retry.
    console.error("[onboarding] registerCompany failed");
    engineFailed = true;
  }

  const certMeta = await extractCertificateMetadata(certBuffer, certPassword);
  const emitenteStatus = engineFailed
    ? EmitenteStatus.PENDING_SETUP
    : EmitenteStatus.ACTIVE;

  const emitenteData = {
    razaoSocial,
    nomeFantasia: nomeFantasia || null,
    inscricaoEstadual,
    inscricaoMunicipal: inscricaoMunicipal || null,
    regimeTributario,
    logradouro,
    numero,
    complemento: complemento || null,
    bairro,
    codigoMunicipioIbge,
    municipio,
    uf,
    cep,
    telefone: telefone || null,
    email: email || null,
    fiscalEngineCompanyRef: companyRef,
    status: emitenteStatus,
  };

  await prisma.$transaction(async (tx) => {
    const emitente = await tx.emitente.upsert({
      where: { shopId_cnpj: { shopId: shop.id, cnpj } },
      update: emitenteData,
      create: { shopId: shop.id, cnpj, ...emitenteData },
    });

    await tx.fiscalSettings.upsert({
      where: { emitenteId: emitente.id },
      update: { ambiente, tipoDocumento, serie, proximoNumero, naturezaOperacao },
      create: {
        emitenteId: emitente.id,
        ambiente,
        tipoDocumento,
        serie,
        proximoNumero,
        naturezaOperacao,
      },
    });

    await tx.certificate.upsert({
      where: { emitenteId: emitente.id },
      update: {
        subjectCnpj: certMeta.subjectCnpj,
        validFrom: certMeta.validFrom,
        validTo: certMeta.validTo,
        status: CertificateStatus.ACTIVE,
        uploadedAt: new Date(),
      },
      create: {
        emitenteId: emitente.id,
        subjectCnpj: certMeta.subjectCnpj,
        validFrom: certMeta.validFrom,
        validTo: certMeta.validTo,
        status: CertificateStatus.ACTIVE,
      },
    });
  });

  if (engineFailed) {
    return {
      ok: false,
      formError:
        "Salvamos seus dados, mas o registro no provedor fiscal falhou. Revise o certificado/senha e tente novamente.",
      fieldErrors: {},
    };
  }

  return redirect("/app");
};

// ---------------------------------------------------------------------------
// UI: client-managed multi-step wizard. All fields live in React state and are
// submitted together (multipart) on the final step.
// ---------------------------------------------------------------------------

// Pure string constants matching the Prisma enum values in the schema. Do NOT
// reference @prisma/client enums here — this runs in the client component, and
// Prisma's generated enums are server-only (undefined in the browser bundle, which
// crashes the render). See CLAUDE.md "Prisma no client (regra rígida)".
const REGIME_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "SIMPLES_NACIONAL", label: "Simples Nacional" },
  { value: "SIMPLES_NACIONAL_MEI", label: "Simples Nacional – MEI" },
  {
    value: "SIMPLES_EXCESSO_SUBLIMITE",
    label: "Simples Nacional – excesso de sublimite",
  },
  {
    value: "REGIME_NORMAL",
    label: "Regime Normal (Lucro Presumido ou Lucro Real)",
  },
];

// The 27 Brazilian states (UF codes).
const UF_OPTIONS = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG",
  "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE",
  "TO",
];
// Server-side guard derived from the same list, used by the action. (M4)
const UF_SET = new Set(UF_OPTIONS);

const INITIAL = {
  cnpj: "",
  razaoSocial: "",
  nomeFantasia: "",
  inscricaoEstadual: "",
  inscricaoMunicipal: "",
  regimeTributario: "SIMPLES_NACIONAL",
  cep: "",
  logradouro: "",
  numero: "",
  complemento: "",
  bairro: "",
  municipio: "",
  uf: "",
  codigoMunicipioIbge: "",
  telefone: "",
  email: "",
  ambiente: "HOMOLOGACAO",
  tipoDocumento: "NFE",
  serie: "1",
  proximoNumero: "1",
  naturezaOperacao: "Venda de mercadoria",
  certPassword: "",
};

type Values = typeof INITIAL;

const TOTAL_STEPS = 5;
const STEP_TITLES = [
  "Dados da empresa",
  "Endereço",
  "Certificado A1",
  "Configuração de emissão",
  "Revisão",
];

export default function Onboarding() {
  const [step, setStep] = useState(1);
  const [values, setValues] = useState<Values>(INITIAL);
  const [certFile, setCertFile] = useState<File | null>(null);
  const [isentoIe, setIsentoIe] = useState(false);

  const cnpjFetcher = useFetcher<LookupResponse<CnpjLookupResult>>();
  const cepFetcher = useFetcher<LookupResponse<CepLookupResult>>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const actionData = useActionData<typeof action>();
  const submitting = navigation.state === "submitting";

  const setValue = (name: keyof Values, value: string) =>
    setValues((v) => ({ ...v, [name]: value }));

  // Apply BrasilAPI result once per lookup, without clobbering fields the user
  // already filled. The CNPJ result's address is stored masked for display.
  const lastCnpj = useRef<unknown>(null);
  useEffect(() => {
    const r = cnpjFetcher.data;
    if (!r || r === lastCnpj.current) return;
    lastCnpj.current = r;
    if (r.ok) {
      const d = r.data;
      setValues((v) => ({
        ...v,
        razaoSocial: v.razaoSocial || d.razaoSocial,
        nomeFantasia: v.nomeFantasia || d.nomeFantasia,
        cep: v.cep || maskCep(d.cep),
        logradouro: v.logradouro || d.logradouro,
        numero: v.numero || d.numero,
        complemento: v.complemento || d.complemento,
        bairro: v.bairro || d.bairro,
        municipio: v.municipio || d.municipio,
        uf: v.uf || d.uf,
        codigoMunicipioIbge: v.codigoMunicipioIbge || d.codigoMunicipioIbge,
        telefone: v.telefone || maskPhone(d.telefone),
        email: v.email || d.email,
      }));
    }
  }, [cnpjFetcher.data]);

  const lastCep = useRef<unknown>(null);
  useEffect(() => {
    const r = cepFetcher.data;
    if (!r || r === lastCep.current) return;
    lastCep.current = r;
    if (r.ok) {
      const d = r.data;
      setValues((v) => ({
        ...v,
        logradouro: d.logradouro || v.logradouro,
        bairro: d.bairro || v.bairro,
        municipio: d.municipio || v.municipio,
        uf: d.uf || v.uf,
        codigoMunicipioIbge: d.codigoMunicipioIbge || v.codigoMunicipioIbge,
      }));
    }
  }, [cepFetcher.data]);

  const lookupCnpj = (raw: string) => {
    const digits = normalizeCnpj(raw);
    if (isValidCnpj(digits)) cnpjFetcher.load(`/app/api/cnpj?cnpj=${digits}`);
  };
  const lookupCep = (raw: string) => {
    const digits = normalizeCep(raw);
    if (isValidCep(digits)) cepFetcher.load(`/app/api/cep?cep=${digits}`);
  };

  const cnpjLoading = cnpjFetcher.state !== "idle";
  const cepLoading = cepFetcher.state !== "idle";

  const emailValid = values.email === "" || isValidEmail(values.email);

  const stepValid = (s: number): boolean => {
    if (s === 1)
      return (
        isValidCnpj(values.cnpj) &&
        !!values.razaoSocial &&
        (isentoIe || !!values.inscricaoEstadual)
      );
    if (s === 2)
      return (
        isValidCep(values.cep) &&
        !!values.logradouro &&
        !!values.numero &&
        !!values.bairro &&
        !!values.municipio &&
        values.uf.trim().length === 2 &&
        values.codigoMunicipioIbge.trim().length >= 7 &&
        emailValid
      );
    if (s === 3) return !!certFile && !!values.certPassword;
    if (s === 4) return Number(values.serie) >= 1 && Number(values.proximoNumero) >= 1;
    return true;
  };

  const next = () => setStep((s) => Math.min(TOTAL_STEPS, s + 1));
  const back = () => setStep((s) => Math.max(1, s - 1));

  const handleSubmit = () => {
    const fd = new FormData();
    (Object.keys(values) as Array<keyof Values>).forEach((k) =>
      fd.append(k, values[k]),
    );
    if (certFile) fd.append("certificate", certFile, certFile.name);
    submit(fd, { method: "post", encType: "multipart/form-data" });
  };

  const serverFieldErrors = actionData?.fieldErrors ?? {};
  const err = (name: string) => serverFieldErrors[name];

  return (
    <s-page heading="Configuração fiscal">
      <s-section heading={`Passo ${step} de ${TOTAL_STEPS}: ${STEP_TITLES[step - 1]}`}>
        {actionData?.formError ? (
          <s-banner tone="critical" heading="Não foi possível concluir">
            {actionData.formError}
          </s-banner>
        ) : null}

        {/* STEP 1 — Dados da empresa */}
        {step === 1 ? (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Informe o CNPJ da loja. Buscamos automaticamente a razão social, o
              nome fantasia e o endereço.
            </s-paragraph>
            <s-stack direction="inline" gap="base" alignItems="end">
              <WcTextField
                label="CNPJ"
                placeholder="00.000.000/0000-00"
                value={values.cnpj}
                format={maskCnpj}
                onValueChange={(v) => setValue("cnpj", v)}
                onCommit={(v) => lookupCnpj(v)}
                error={
                  values.cnpj && !isValidCnpj(values.cnpj)
                    ? "CNPJ inválido"
                    : err("cnpj")
                }
              />
              <s-button
                onClick={() => lookupCnpj(values.cnpj)}
                {...(cnpjLoading ? { loading: true } : {})}
                {...(!isValidCnpj(values.cnpj) ? { disabled: true } : {})}
              >
                Buscar dados
              </s-button>
            </s-stack>

            {cnpjFetcher.data && !cnpjFetcher.data.ok && !cnpjLoading ? (
              <s-banner tone="info" heading="Preenchimento manual">
                Não encontramos os dados automaticamente. Você pode preencher os
                campos manualmente.
              </s-banner>
            ) : null}

            <WcTextField
              label="Razão social"
              value={values.razaoSocial}
              onValueChange={(v) => setValue("razaoSocial", v)}
              error={err("razaoSocial")}
            />
            <WcTextField
              label="Nome fantasia (opcional)"
              value={values.nomeFantasia}
              onValueChange={(v) => setValue("nomeFantasia", v)}
            />
            <WcCheckbox
              label="Isento de Inscrição Estadual"
              checked={isentoIe}
              onCheckedChange={(c) => {
                setIsentoIe(c);
                setValue("inscricaoEstadual", c ? "ISENTO" : "");
              }}
            />
            <s-stack direction="inline" gap="base">
              {!isentoIe ? (
                <WcTextField
                  label="Inscrição estadual"
                  value={values.inscricaoEstadual}
                  onValueChange={(v) => setValue("inscricaoEstadual", v)}
                  error={err("inscricaoEstadual")}
                />
              ) : null}
              <WcTextField
                label="Inscrição municipal (opcional)"
                value={values.inscricaoMunicipal}
                onValueChange={(v) => setValue("inscricaoMunicipal", v)}
              />
            </s-stack>
            <WcSelect
              label="Regime tributário"
              value={values.regimeTributario}
              onValueChange={(v) => setValue("regimeTributario", v)}
            >
              {REGIME_OPTIONS.map((o) => (
                <s-option key={o.value} value={o.value}>
                  {o.label}
                </s-option>
              ))}
            </WcSelect>
          </s-stack>
        ) : null}

        {/* STEP 2 — Endereço */}
        {step === 2 ? (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Informe o CEP para preencher o endereço automaticamente. Número e
              complemento são manuais.
            </s-paragraph>
            <s-stack direction="inline" gap="base" alignItems="end">
              <WcTextField
                label="CEP"
                placeholder="00000-000"
                value={values.cep}
                format={maskCep}
                onValueChange={(v) => setValue("cep", v)}
                onCommit={(v) => lookupCep(v)}
                error={
                  values.cep && !isValidCep(values.cep)
                    ? "CEP inválido"
                    : err("cep")
                }
              />
              <s-button
                onClick={() => lookupCep(values.cep)}
                {...(cepLoading ? { loading: true } : {})}
                {...(!isValidCep(values.cep) ? { disabled: true } : {})}
              >
                Buscar CEP
              </s-button>
            </s-stack>

            {cepFetcher.data && !cepFetcher.data.ok && !cepLoading ? (
              <s-banner tone="info" heading="Preenchimento manual">
                Não encontramos esse CEP. Preencha o endereço manualmente.
              </s-banner>
            ) : null}

            <WcTextField
              label="Logradouro"
              value={values.logradouro}
              onValueChange={(v) => setValue("logradouro", v)}
              error={err("logradouro")}
            />
            <s-stack direction="inline" gap="base">
              <WcTextField
                label="Número"
                placeholder="123 ou S/N"
                value={values.numero}
                onValueChange={(v) => setValue("numero", v)}
                error={err("numero")}
              />
              <WcTextField
                label="Complemento (opcional)"
                value={values.complemento}
                onValueChange={(v) => setValue("complemento", v)}
              />
            </s-stack>
            <WcTextField
              label="Bairro"
              value={values.bairro}
              onValueChange={(v) => setValue("bairro", v)}
              error={err("bairro")}
            />
            <s-stack direction="inline" gap="base">
              <WcTextField
                label="Município"
                value={values.municipio}
                onValueChange={(v) => setValue("municipio", v)}
                error={err("municipio")}
              />
              <WcSelect
                label="UF"
                placeholder="UF"
                value={values.uf}
                onValueChange={(v) => setValue("uf", v)}
              >
                {UF_OPTIONS.map((uf) => (
                  <s-option key={uf} value={uf}>
                    {uf}
                  </s-option>
                ))}
              </WcSelect>
            </s-stack>
            <WcTextField
              label="Código IBGE do município"
              details="Preenchido automaticamente pela busca de CEP."
              value={values.codigoMunicipioIbge}
              onValueChange={(v) => setValue("codigoMunicipioIbge", v)}
              error={err("codigoMunicipioIbge")}
            />
            <s-stack direction="inline" gap="base">
              <WcTextField
                label="Telefone (opcional)"
                placeholder="(11) 91234-5678"
                value={values.telefone}
                format={maskPhone}
                onValueChange={(v) => setValue("telefone", v)}
              />
              <WcTextField
                label="E-mail (opcional)"
                placeholder="contato@loja.com.br"
                value={values.email}
                onValueChange={(v) => setValue("email", v)}
                error={
                  values.email && !isValidEmail(values.email)
                    ? "E-mail inválido"
                    : err("email")
                }
              />
            </s-stack>
          </s-stack>
        ) : null}

        {/* STEP 3 — Certificado A1 */}
        {step === 3 ? (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Envie o certificado digital A1 (.pfx ou .p12) e a senha. O arquivo
              é encaminhado ao provedor fiscal e <s-text type="strong">não é
              armazenado</s-text> por nós.
            </s-paragraph>
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <s-stack direction="block" gap="small-200">
                <label htmlFor="certificate">
                  <s-text type="strong">Arquivo do certificado (.pfx / .p12)</s-text>
                </label>
                <input
                  id="certificate"
                  type="file"
                  accept=".pfx,.p12,application/x-pkcs12"
                  onChange={(e) =>
                    setCertFile(e.currentTarget.files?.[0] ?? null)
                  }
                />
                {certFile ? (
                  <s-text tone="success">Selecionado: {certFile.name}</s-text>
                ) : null}
                {err("certificate") ? (
                  <s-text tone="critical">{err("certificate")}</s-text>
                ) : null}
              </s-stack>
            </s-box>
            <WcPasswordField
              label="Senha do certificado"
              value={values.certPassword}
              onValueChange={(v) => setValue("certPassword", v)}
              error={err("certPassword")}
            />
          </s-stack>
        ) : null}

        {/* STEP 4 — Configuração de emissão */}
        {step === 4 ? (
          <s-stack direction="block" gap="base">
            <WcSelect
              label="Ambiente"
              details="Use homologação para testes antes de emitir notas válidas."
              value={values.ambiente}
              onValueChange={(v) => setValue("ambiente", v)}
            >
              <s-option value="HOMOLOGACAO">Homologação (testes)</s-option>
              <s-option value="PRODUCAO">Produção</s-option>
            </WcSelect>
            <WcSelect
              label="Tipo de documento"
              value={values.tipoDocumento}
              onValueChange={(v) => setValue("tipoDocumento", v)}
            >
              <s-option value="NFE">NF-e (mod. 55)</s-option>
              <s-option value="NFCE">NFC-e (mod. 65)</s-option>
            </WcSelect>
            <s-paragraph>
              A série e o próximo número definem a numeração das suas notas. Se
              você já emitiu notas em outro sistema, ajuste estes valores para{" "}
              <s-text type="strong">não conflitar</s-text> com a numeração já
              usada — números repetidos serão rejeitados pela SEFAZ.
            </s-paragraph>
            <s-stack direction="inline" gap="base">
              <WcNumberField
                label="Série"
                value={values.serie}
                onValueChange={(v) => setValue("serie", v)}
                min={1}
              />
              <WcNumberField
                label="Próximo número"
                details="Número da próxima nota a ser emitida."
                value={values.proximoNumero}
                onValueChange={(v) => setValue("proximoNumero", v)}
                min={1}
              />
            </s-stack>
            <WcTextField
              label="Natureza da operação"
              value={values.naturezaOperacao}
              onValueChange={(v) => setValue("naturezaOperacao", v)}
            />
          </s-stack>
        ) : null}

        {/* STEP 5 — Revisão */}
        {step === 5 ? (
          <s-stack direction="block" gap="base">
            <s-paragraph>Revise os dados antes de salvar.</s-paragraph>
            <ReviewRow label="CNPJ" value={values.cnpj} />
            <ReviewRow label="Razão social" value={values.razaoSocial} />
            <ReviewRow label="Nome fantasia" value={values.nomeFantasia || "—"} />
            <ReviewRow
              label="Inscrição estadual"
              value={values.inscricaoEstadual}
            />
            <ReviewRow
              label="Regime"
              value={
                REGIME_OPTIONS.find((o) => o.value === values.regimeTributario)
                  ?.label ?? values.regimeTributario
              }
            />
            <ReviewRow
              label="Endereço"
              value={`${values.logradouro}, ${values.numero}${
                values.complemento ? ` - ${values.complemento}` : ""
              } - ${values.bairro}, ${values.municipio}/${values.uf} - ${values.cep}`}
            />
            <ReviewRow label="Código IBGE" value={values.codigoMunicipioIbge} />
            <ReviewRow
              label="Contato"
              value={`${values.telefone || "—"} · ${values.email || "—"}`}
            />
            <ReviewRow label="Ambiente" value={values.ambiente} />
            <ReviewRow
              label="Documento / Série / Próx. nº"
              value={`${values.tipoDocumento} / ${values.serie} / ${values.proximoNumero}`}
            />
            <ReviewRow
              label="Certificado"
              value={certFile ? certFile.name : "Nenhum arquivo"}
            />
          </s-stack>
        ) : null}

        {/* Navigation */}
        <s-stack direction="inline" gap="base">
          {step > 1 ? (
            <s-button onClick={back} {...(submitting ? { disabled: true } : {})}>
              Voltar
            </s-button>
          ) : null}
          {step < TOTAL_STEPS ? (
            <s-button
              variant="primary"
              onClick={next}
              {...(!stepValid(step) ? { disabled: true } : {})}
            >
              Continuar
            </s-button>
          ) : (
            <s-button
              variant="primary"
              onClick={handleSubmit}
              {...(submitting ? { loading: true } : {})}
              {...(submitting ? { disabled: true } : {})}
            >
              Concluir e salvar
            </s-button>
          )}
        </s-stack>

        {!stepValid(step) && step < TOTAL_STEPS ? (
          <s-text color="subdued">
            Preencha os campos obrigatórios para continuar.
          </s-text>
        ) : null}
      </s-section>
    </s-page>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <s-stack direction="inline" gap="base">
      <s-box minInlineSize="180px">
        <s-text color="subdued">{label}</s-text>
      </s-box>
      <s-text>{value}</s-text>
    </s-stack>
  );
}

// ---------------------------------------------------------------------------
// Polaris web-component field wrappers.
//
// Binding uses addEventListener on the element (input/change) — NOT the React
// on* props — because the handler both READS `el.value` and WRITES it back as a
// PROPERTY. That write-back is what lets the input mask reformat on the fly and
// what makes lookups/programmatic updates show up (the React `value` prop only
// sets the attribute → defaultValue, so it never re-renders the field text).
// See CLAUDE.md / [[polaris-web-components]].
// ---------------------------------------------------------------------------

type WcEl = HTMLElement & { value: string };

function useWcField(
  value: string,
  onValueChange: (value: string) => void,
  onCommit?: (value: string) => void,
  format?: (raw: string) => string,
) {
  const elRef = useRef<WcEl | null>(null);
  const changeCb = useRef(onValueChange);
  const commitCb = useRef(onCommit);
  const fmtCb = useRef(format);
  changeCb.current = onValueChange;
  commitCb.current = onCommit;
  fmtCb.current = format;

  // Stable handlers so add/removeEventListener pair up across renders. The mask is
  // applied here and written straight back onto the element's `value` property.
  const handlers = useRef({
    input: (e: Event) => {
      const el = e.currentTarget as WcEl;
      const fmt = fmtCb.current;
      const next = fmt ? fmt(el.value) : el.value;
      if (fmt && el.value !== next) el.value = next;
      changeCb.current(next);
    },
    change: (e: Event) => {
      const el = e.currentTarget as WcEl;
      const fmt = fmtCb.current;
      const next = fmt ? fmt(el.value) : el.value;
      if (fmt && el.value !== next) el.value = next;
      changeCb.current(next);
      commitCb.current?.(next);
    },
  });

  const setRef = useCallback((el: HTMLElement | null) => {
    const prev = elRef.current;
    if (prev) {
      prev.removeEventListener("input", handlers.current.input);
      prev.removeEventListener("change", handlers.current.change);
    }
    elRef.current = el as WcEl | null;
    if (el) {
      el.addEventListener("input", handlers.current.input);
      el.addEventListener("change", handlers.current.change);
    }
  }, []);

  // Mirror programmatic/controlled updates (e.g. autofill lookups) onto the property.
  useEffect(() => {
    const el = elRef.current;
    if (el && el.value !== value) el.value = value;
  }, [value]);

  return setRef;
}

function WcTextField({
  label,
  value,
  onValueChange,
  onCommit,
  format,
  placeholder,
  error,
  details,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  onCommit?: (value: string) => void;
  format?: (raw: string) => string;
  placeholder?: string;
  error?: string;
  details?: string;
}) {
  const ref = useWcField(value, onValueChange, onCommit, format);
  return (
    <s-text-field
      ref={ref}
      label={label}
      placeholder={placeholder}
      error={error}
      details={details}
    />
  );
}

function WcPasswordField({
  label,
  value,
  onValueChange,
  error,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  error?: string;
}) {
  const ref = useWcField(value, onValueChange);
  return <s-password-field ref={ref} label={label} error={error} />;
}

function WcNumberField({
  label,
  value,
  onValueChange,
  min,
  details,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  min?: number;
  details?: string;
}) {
  const ref = useWcField(value, onValueChange);
  return <s-number-field ref={ref} label={label} min={min} details={details} />;
}

function WcSelect({
  label,
  value,
  onValueChange,
  details,
  placeholder,
  children,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  details?: string;
  placeholder?: string;
  children: ReactNode;
}) {
  const ref = useWcField(value, onValueChange);
  return (
    <s-select ref={ref} label={label} details={details} placeholder={placeholder}>
      {children}
    </s-select>
  );
}

function WcCheckbox({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  type CheckEl = HTMLElement & { checked: boolean };
  const elRef = useRef<CheckEl | null>(null);
  const cb = useRef(onCheckedChange);
  cb.current = onCheckedChange;
  const handler = useRef((e: Event) =>
    cb.current((e.currentTarget as CheckEl).checked),
  );
  const setRef = useCallback((el: HTMLElement | null) => {
    const prev = elRef.current;
    if (prev) {
      prev.removeEventListener("change", handler.current);
      prev.removeEventListener("input", handler.current);
    }
    elRef.current = el as CheckEl | null;
    if (el) {
      el.addEventListener("change", handler.current);
      el.addEventListener("input", handler.current);
    }
  }, []);
  useEffect(() => {
    const el = elRef.current;
    if (el && el.checked !== checked) el.checked = checked;
  }, [checked]);
  return <s-checkbox ref={setRef} label={label} />;
}
