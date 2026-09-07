-- CreateEnum
CREATE TYPE "KeyStatus" AS ENUM ('active', 'revoked');

-- CreateEnum
CREATE TYPE "AnomalyMode" AS ENUM ('off', 'async', 'sync');

-- CreateEnum
CREATE TYPE "Verdict" AS ENUM ('benign', 'suspicious', 'malicious');

-- CreateEnum
CREATE TYPE "ReviewLabel" AS ENUM ('true_positive', 'false_positive');

-- CreateTable
CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit_policies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "windowSeconds" INTEGER NOT NULL,
    "maxRequests" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_limit_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "KeyStatus" NOT NULL DEFAULT 'active',
    "policyId" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routes" (
    "id" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "upstream" TEXT NOT NULL,
    "stripPrefix" BOOLEAN NOT NULL DEFAULT true,
    "methods" TEXT[] DEFAULT ARRAY['*']::TEXT[],
    "authRequired" BOOLEAN NOT NULL DEFAULT true,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "policyId" TEXT,
    "cacheTtlSeconds" INTEGER NOT NULL DEFAULT 0,
    "anomalyMode" "AnomalyMode" NOT NULL DEFAULT 'async',
    "timeoutMs" INTEGER NOT NULL DEFAULT 30000,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "anomaly_events" (
    "id" TEXT NOT NULL,
    "requestId" VARCHAR(64) NOT NULL,
    "apiKeyId" TEXT,
    "routeId" TEXT,
    "clientIp" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "heuristicScore" DOUBLE PRECISION NOT NULL,
    "llmScore" DOUBLE PRECISION,
    "verdict" "Verdict",
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reasoning" TEXT,
    "model" TEXT,
    "llmLatencyMs" INTEGER,
    "payloadSample" VARCHAR(2000),
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "reviewed" BOOLEAN NOT NULL DEFAULT false,
    "reviewLabel" "ReviewLabel",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "anomaly_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "rate_limit_policies_name_key" ON "rate_limit_policies"("name");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");

-- CreateIndex
CREATE INDEX "api_keys_status_idx" ON "api_keys"("status");

-- CreateIndex
CREATE UNIQUE INDEX "routes_service_key" ON "routes"("service");

-- CreateIndex
CREATE INDEX "anomaly_events_createdAt_idx" ON "anomaly_events"("createdAt");

-- CreateIndex
CREATE INDEX "anomaly_events_apiKeyId_createdAt_idx" ON "anomaly_events"("apiKeyId", "createdAt");

-- CreateIndex
CREATE INDEX "anomaly_events_llmScore_idx" ON "anomaly_events"("llmScore");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "rate_limit_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routes" ADD CONSTRAINT "routes_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "rate_limit_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anomaly_events" ADD CONSTRAINT "anomaly_events_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anomaly_events" ADD CONSTRAINT "anomaly_events_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "routes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
