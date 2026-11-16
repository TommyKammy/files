-- ============================================================================
-- Migration: 0012_admin_bulk_idempotency.sql
-- Purpose:   P9-7 / TOM-57 durable idempotency for tenant-admin bulk operations.
--
-- `(tenant_id, idempotency_key)` is the natural key: a key may only be reused
-- for the same operation and request payload. `in_progress` lets concurrent
-- duplicates fail fast with 409 BULK_OPERATION_IN_PROGRESS, while `completed`
-- rows replay the stored response with `replayed: true`.
-- ============================================================================

CREATE TABLE admin_bulk_idempotency (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
  response_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, idempotency_key)
);

CREATE INDEX idx_admin_bulk_idempotency_operation
  ON admin_bulk_idempotency(tenant_id, operation, status);
