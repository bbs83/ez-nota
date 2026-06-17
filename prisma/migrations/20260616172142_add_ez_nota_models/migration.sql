-- CreateEnum
CREATE TYPE "ShopStatus" AS ENUM ('ACTIVE', 'UNINSTALLED');

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('TRIAL', 'STARTER', 'GROWTH', 'PRO');

-- CreateEnum
CREATE TYPE "RegimeTributario" AS ENUM ('SIMPLES_NACIONAL', 'SIMPLES_EXCESSO_SUBLIMITE', 'REGIME_NORMAL');

-- CreateEnum
CREATE TYPE "FiscalEngineProvider" AS ENUM ('FOCUS_NFE', 'PLUGNOTAS', 'NFE_IO');

-- CreateEnum
CREATE TYPE "EmitenteStatus" AS ENUM ('PENDING_SETUP', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "CertificateStatus" AS ENUM ('ACTIVE', 'EXPIRING_SOON', 'EXPIRED', 'INVALID');

-- CreateEnum
CREATE TYPE "Ambiente" AS ENUM ('HOMOLOGACAO', 'PRODUCAO');

-- CreateEnum
CREATE TYPE "TipoDocumento" AS ENUM ('NFE', 'NFCE');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('PENDING', 'PROCESSING', 'AUTHORIZED', 'REJECTED', 'CANCELLED', 'ERROR');

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "status" "ShopStatus" NOT NULL DEFAULT 'ACTIVE',
    "planTier" "PlanTier" NOT NULL DEFAULT 'TRIAL',
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Emitente" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "cnpj" TEXT NOT NULL,
    "razaoSocial" TEXT NOT NULL,
    "nomeFantasia" TEXT,
    "inscricaoEstadual" TEXT NOT NULL,
    "inscricaoMunicipal" TEXT,
    "regimeTributario" "RegimeTributario" NOT NULL DEFAULT 'SIMPLES_NACIONAL',
    "regimeEspecialTributacao" TEXT,
    "logradouro" TEXT NOT NULL,
    "numero" TEXT NOT NULL,
    "complemento" TEXT,
    "bairro" TEXT NOT NULL,
    "codigoMunicipioIbge" TEXT NOT NULL,
    "municipio" TEXT NOT NULL,
    "uf" TEXT NOT NULL,
    "cep" TEXT NOT NULL,
    "telefone" TEXT,
    "email" TEXT,
    "fiscalEngineProvider" "FiscalEngineProvider" NOT NULL DEFAULT 'FOCUS_NFE',
    "fiscalEngineCompanyRef" TEXT,
    "status" "EmitenteStatus" NOT NULL DEFAULT 'PENDING_SETUP',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Emitente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Certificate" (
    "id" TEXT NOT NULL,
    "emitenteId" TEXT NOT NULL,
    "subjectCnpj" TEXT,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "status" "CertificateStatus" NOT NULL DEFAULT 'ACTIVE',
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Certificate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalSettings" (
    "id" TEXT NOT NULL,
    "emitenteId" TEXT NOT NULL,
    "ambiente" "Ambiente" NOT NULL DEFAULT 'HOMOLOGACAO',
    "tipoDocumento" "TipoDocumento" NOT NULL DEFAULT 'NFE',
    "serie" INTEGER NOT NULL DEFAULT 1,
    "proximoNumero" INTEGER NOT NULL DEFAULT 1,
    "naturezaOperacao" TEXT NOT NULL DEFAULT 'Venda de mercadoria',
    "defaultCfop" TEXT NOT NULL DEFAULT '5102',
    "defaultCsosn" TEXT NOT NULL DEFAULT '102',
    "defaultOrigem" TEXT NOT NULL DEFAULT '0',
    "defaultNcm" TEXT,
    "emiteAposPagamento" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FiscalSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductFiscalMapping" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyProductId" TEXT,
    "shopifyVariantId" TEXT NOT NULL,
    "ncm" TEXT NOT NULL,
    "cfop" TEXT,
    "csosn" TEXT,
    "origem" TEXT,
    "cest" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductFiscalMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "emitenteId" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyOrderName" TEXT,
    "tipo" "TipoDocumento" NOT NULL DEFAULT 'NFE',
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "ambiente" "Ambiente" NOT NULL,
    "fiscalEngineRef" TEXT,
    "numero" INTEGER,
    "serie" INTEGER,
    "chaveAcesso" TEXT,
    "protocolo" TEXT,
    "xmlUrl" TEXT,
    "danfeUrl" TEXT,
    "valorTotal" DECIMAL(12,2),
    "mensagemSefaz" TEXT,
    "rejeicaoCodigo" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "requestPayload" JSONB,
    "responsePayload" JSONB,
    "emittedAt" TIMESTAMP(3),
    "authorizedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "Emitente_shopId_cnpj_key" ON "Emitente"("shopId", "cnpj");

-- CreateIndex
CREATE UNIQUE INDEX "Certificate_emitenteId_key" ON "Certificate"("emitenteId");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalSettings_emitenteId_key" ON "FiscalSettings"("emitenteId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductFiscalMapping_shopId_shopifyVariantId_key" ON "ProductFiscalMapping"("shopId", "shopifyVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_idempotencyKey_key" ON "Invoice"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Invoice_shopId_shopifyOrderId_idx" ON "Invoice"("shopId", "shopifyOrderId");

-- CreateIndex
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");

-- AddForeignKey
ALTER TABLE "Emitente" ADD CONSTRAINT "Emitente_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_emitenteId_fkey" FOREIGN KEY ("emitenteId") REFERENCES "Emitente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalSettings" ADD CONSTRAINT "FiscalSettings_emitenteId_fkey" FOREIGN KEY ("emitenteId") REFERENCES "Emitente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductFiscalMapping" ADD CONSTRAINT "ProductFiscalMapping_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_emitenteId_fkey" FOREIGN KEY ("emitenteId") REFERENCES "Emitente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
