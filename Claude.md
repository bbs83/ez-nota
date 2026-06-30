# EZ Nota — Project Guide for Claude Code

## What this is
EZ Nota is a Shopify embedded app (Shopify App Store, Brazil-only) that gives
Brazilian merchants the fiscal layer Shopify never built natively: automatic
NF-e/NFC-e issuance, plus address-field correction and Pix discount (later
modules). It is a "kit Brasil" — a full local solution for the Brazilian
Shopify merchant. Goal: a COMPLETE, production-grade product, not a toy.
Built solo with Claude Code, designed to run with minimal human ops.

## Target user (ICP)
Brazilian Shopify stores with an active CNPJ, ~100–1000 orders/month, on
**Simples Nacional** (CRT 1), without an ERP or wanting to drop one. MVP
targets Simples Nacional only (avoids DIFAL / ICMS-credit complexity).

## Stack
- Shopify app: React Router template + App Bridge + Polaris web components.
  Embedded admin.
- Auth: Shopify managed installation / token exchange. Do NOT hand-roll OAuth.
- DB: PostgreSQL on Supabase via Prisma. DATABASE_URL = transaction pooler
  (6543, pgbouncer); DIRECT_URL = session pooler (5432) for migrations.
- Hosting target: Vercel. Language: TypeScript.
- Fiscal engine: Focus NFe (MVP). PlugNotas/NFE.io as future alternatives.

## Prisma no client (regra rígida)
@prisma/client e os enums gerados pelo Prisma são SERVER-ONLY. Nunca importar/usar
VALORES do @prisma/client em código que roda no navegador (componentes/render) — no
bundle do cliente eles ficam undefined e quebram o render com TypeError. No client:
constantes de string puras para opções, e `import type` para os tipos. Prisma só em
loader/action/servidor.

## Architecture decisions (do not violate)
1. Fiscal-engine ADAPTER layer. All engine calls go through an internal
   interface so Focus can be swapped later. Never call Focus from route handlers.
2. Certificate custody is DELEGATED to the engine. The merchant's A1 cert (.pfx)
   is forwarded to Focus at onboarding and held there. EZ Nota NEVER persists
   the .pfx or its password to disk/DB — memory-only during the request. Store
   only the Focus "empresa" reference + cert metadata (CNPJ, validFrom/validTo,
   status) for expiry alerts.
3. Multi-tenant. Every installed shop is a tenant (Shop); all data scoped by
   shopId. One Emitente per Shop for MVP, modeled as a relation for future
   multi-CNPJ.
4. Idempotency. Never emit a duplicate NF-e for the same order. Invoice has an
   idempotencyKey; webhook handlers must be idempotent (Shopify may redeliver).
5. Secrets via env only. Never commit .env. Never log secrets, certificates,
   or full connection strings.

## Data model (Prisma)
Session (existing) · Shop (tenant) · Emitente (CNPJ, IE, regime, address, Focus
ref) · Certificate (metadata only) · FiscalSettings (emission defaults) ·
ProductFiscalMapping (NCM/CFOP/CSOSN per product) · Invoice (each issued note,
linked to a Shopify order). WebhookEvent/AuditLog added with the webhook handler.

## Brazilian fiscal glossary (so emission is correct)
- NF-e (mod. 55): invoice for goods. NFC-e (mod. 65): consumer receipt.
- CNPJ/IE: federal/state tax IDs. Simples Nacional / CRT 1: our MVP regime.
- CFOP: operation code (5102 = sale of goods intrastate; 6xxx = interstate).
- CSOSN: tax-situation code for Simples (102 = taxed, no credit).
- NCM: product classification (required per product line). Origem: 0 = national.
- Chave de acesso: 44-digit key of an authorized note. DANFE: printable PDF.
- Ambiente: homologação (test) vs produção (live).
- CC-e / cancelamento / devolução: correction letter / cancel / return note (post-MVP).
- Reforma Tributária (CBS/IBS): ongoing transition; engine handles the technical
  side — keep settings current.

## MVP scope (build in order)
1. [done] Foundation: Prisma → Supabase Postgres.
2. Data model (Prisma models above).
3. Onboarding wizard (Polaris): CNPJ/IE/regime, upload A1 cert → forward to
   Focus, série/numeração, environment.
4. Fiscal core: orders/paid webhook → build NF-e payload (NCM/CFOP/CSOSN) →
   emit via Focus adapter → attach XML/DANFE to order → cancel on refund.
5. Address corrector: split Shopify's single address field into
   logradouro/número/bairro, with manual fallback.
6. Billing (Shopify Billing API, tiered by monthly note volume) + fiscal
   dashboard + submit for App Store review.

## Full-solution roadmap (post-MVP, to complete the "kit")
CC-e, nota de devolução, contingência, email XML/DANFE to customer, NFC-e,
multi-CNPJ, Pix discount module, NFS-e (services) if needed.

## TODOs do fiscal core (do review do onboarding)
- registerCompany idempotente (upsert por CNPJ no engine) + companyRef reconciliável — evitar empresa órfã no Focus se o save no DB falhar (M2).
- HTTP real do Focus: NÃO logar corpo de request; sanitizar erros (cert/senha nunca em log) — decisões #2/#5 (L8).
- Extrair validTo do certificado (resposta do Focus ou node-forge) para o alerta de expiração — decisão #2 (L7).
- Projetar emit/cancel/getStatus de forma agnóstica antes de acoplar ao Focus (trocar engine sem refactor) (L3).
- Deploy: validar transação interativa sob o transaction pooler no Vercel; se falhar, escrever via session pooler/DIRECT_URL (M5).
- M1 [CONCLUÍDO na parte de lógica/visibilidade]: emissão assíncrona — emitInvoice retorna PROCESSING + engineRef (Invoice para em PROCESSING); resolveInvoice/reconcilePendingInvoices (invoice-resolver.server.ts) transicionam para o terminal via adapter.getInvoiceStatus. FEITO: resolver idempotente (update condicional anti-corrida), varredura priorizando as mais antigas, disparo MANUAL na home, detecção de "presa" por cutoff (PROCESSING_STUCK_MINUTES=30, provisório) com contador resolveAttempts + lastResolveAt (migration 20260630_add_invoice_resolve_tracking) e aviso ao lojista. Caso PROCESSING-órfão (sem engineRef) → ERROR reemitível.
- Inutilização de número em rejeição: número rejeitado/denegado é "queimado" (gap aceitável, decisão #4); o resolver NÃO mexe no número. TODO: inutilizar a numeração rejeitada na SEFAZ via engine.
- Gatilho automático da reconciliação: é o que vai EFETIVAMENTE chamar reconcile em produção — entra no DEPLOY (hoje só manual). Cron na Vercel a cada N min OU webhook/callback de status do Focus (preferível: empurra em vez de poll). A lógica (reconcilePendingInvoices) já está pronta para ser chamada pelo gatilho.
- Focus real "preso": além do reclaim por cutoff, pode exigir reconsulta específica / pedido de representação (reprocessamento) do documento na API do Focus — FORA do escopo do stub; tratar quando entrar o HTTP real.
- M5: requestPayload retém PII do destinatário (CPF, endereço, email e telefone) — na compliance: redigir PII do payload persistido (autoritativo é o XML no Focus) + retenção/purga + inventário de dados.
- M6: CFOP explícito intra/inter por cenário (no catálogo), em vez de heurística de prefixo.
- L2/L3: reconciliar total com lojas tax-exclusive; indicador_IE/IE de destinatário B2B (CNPJ contribuinte).
- PCD (produção): a solicitação de Protected Customer Data deve incluir email e phone do cliente, além de nome/endereço — justificativa: a emissão fiscal exige nome, endereço e CPF, e opcionalmente email/telefone para entregar a nota (DANFE/XML) ao cliente.

## Working agreements
- Keep Prisma on 6.x; no major upgrades mid-build.
- Small, reviewable changes. Comment the fiscal logic.
- When a fiscal rule is uncertain (CFOP/CSOSN per scenario), FLAG it for
  human/accountant validation — do not guess.
- Ask before adding heavy dependencies or changing the decisions above.