// kv-publish-plan-fixture.mjs - local-only KVPublishPlan bridge fixture.
//
// This mirrors the data-layer KVPublishEntry contract without importing
// Python from Node: key, ttl_seconds, schema_version, bytes_size,
// value_sha256, value_json. It only builds fake KV bindings for tests.

import { createHash } from "node:crypto";

const ALLOWED_KV_KEYS = new Set([
  "feature_flags",
  "latest_bundle:BTC/USDT:USDT",
  "latest_health:data_layer",
  "public_config",
]);

export const KV_PUBLISH_PLAN_ENTRIES = Object.freeze([
  Object.freeze({
    key: "feature_flags",
    ttl_seconds: 30,
    schema_version: null,
    bytes_size: 53,
    value_sha256: "c69c8beb019cb46495a4923c1d27392824b4d9760b2eae1964083eafb9afe517",
    value_json: "{\"read_worker_enabled\":true,\"show_audit_panel\":false}",
  }),
  Object.freeze({
    key: "latest_bundle:BTC/USDT:USDT",
    ttl_seconds: 300,
    schema_version: "kv.latest_bundle.v1",
    bytes_size: 917,
    value_sha256: "3d44372aee9cf33a4022636db3e25cc2e3b8e4406d3ca212cec88eed4edd6066",
    value_json: "{\"as_of\":\"2026-05-27T00:00:00Z\",\"bundle_created_at\":\"2026-05-27T00:00:03Z\",\"overall_status\":\"ok\",\"r2_bundle_key\":\"bundles/2026-05-27/BTC_USDT_USDT/01HZXKVPUBBUN0000000000001.json\",\"schema_version\":\"kv.latest_bundle.v1\",\"section_statuses\":{\"derivatives\":{\"error_code\":null,\"mandatory\":true,\"present\":true,\"source\":\"bybit_public\",\"stale\":false,\"status\":\"ok\"},\"fundamentals\":{\"error_code\":null,\"mandatory\":false,\"present\":true,\"source\":\"defillama_rest\",\"stale\":false,\"status\":\"ok\"},\"macro\":{\"error_code\":null,\"mandatory\":false,\"present\":true,\"source\":\"fred\",\"stale\":false,\"status\":\"ok\"},\"market\":{\"error_code\":null,\"mandatory\":true,\"present\":true,\"source\":\"bybit_public\",\"stale\":false,\"status\":\"ok\"}},\"snapshot_refs\":{\"derivatives\":\"01HZXKVPUBDRV0000000000001\",\"fundamentals\":\"01HZXKVPUBFND0000000000001\",\"macro\":\"01HZXKVPUBMCR0000000000001\",\"market\":\"01HZXKVPUBMKT0000000000001\"},\"stale\":false,\"symbol\":\"BTC/USDT:USDT\"}",
  }),
  Object.freeze({
    key: "latest_health:data_layer",
    ttl_seconds: 60,
    schema_version: "kv.latest_health.v1",
    bytes_size: 554,
    value_sha256: "59da5264dbd4a171f53a7075be67a9321ad4948aec1f59845d9b2c23b93c2f16",
    value_json: "{\"as_of\":\"2026-05-27T00:00:00Z\",\"generated_at\":\"2026-05-27T00:00:05Z\",\"overall_status\":\"ok\",\"schema_version\":\"kv.latest_health.v1\",\"sources\":{\"bybit_public\":{\"cache_hit\":false,\"degraded\":false,\"error_code\":null,\"last_event_at\":\"2026-05-27T00:00:00Z\",\"latency_ms\":10,\"status\":\"ok\"},\"defillama_rest\":{\"cache_hit\":false,\"degraded\":false,\"error_code\":null,\"last_event_at\":\"2026-05-27T00:00:00Z\",\"latency_ms\":11,\"status\":\"ok\"},\"fred\":{\"cache_hit\":false,\"degraded\":false,\"error_code\":null,\"last_event_at\":\"2026-05-27T00:00:00Z\",\"latency_ms\":12,\"status\":\"ok\"}}}",
  }),
  Object.freeze({
    key: "public_config",
    ttl_seconds: 300,
    schema_version: null,
    bytes_size: 164,
    value_sha256: "e8ef489367ad0b52f05f1f36c357a587e0a26e6c4b78f0d89184097663976db4",
    value_json: "{\"api_version\":\"v1\",\"build_id\":\"phase0-kv-publish-plan\",\"feature_flags\":{\"read_worker_enabled\":true,\"show_audit_panel\":false},\"supported_symbols_url\":\"/v1/symbols\"}",
  }),
]);

export class KVPublishPlanFixtureError extends Error {
  constructor(message) {
    super(message);
    this.name = "KVPublishPlanFixtureError";
  }
}

export function validateKVPublishEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new KVPublishPlanFixtureError("KVPublishEntry must be an object");
  }
  if (!ALLOWED_KV_KEYS.has(entry.key)) {
    throw new KVPublishPlanFixtureError(`KV key is outside the test allowlist: ${entry.key}`);
  }
  if (!Number.isInteger(entry.ttl_seconds) || entry.ttl_seconds < 1) {
    throw new KVPublishPlanFixtureError(`KV entry ${entry.key} has invalid ttl_seconds`);
  }
  if (typeof entry.value_json !== "string") {
    throw new KVPublishPlanFixtureError(`KV entry ${entry.key} value_json must be a string`);
  }
  if (entry.bytes_size !== Buffer.byteLength(entry.value_json, "utf8")) {
    throw new KVPublishPlanFixtureError(`KV entry ${entry.key} bytes_size mismatch`);
  }
  const actualSha256 = createHash("sha256")
    .update(entry.value_json, "utf8")
    .digest("hex");
  if (entry.value_sha256 !== actualSha256) {
    throw new KVPublishPlanFixtureError(`KV entry ${entry.key} value_sha256 mismatch`);
  }
  JSON.parse(entry.value_json);
  return true;
}

export function fakeKVFromKVPublishEntries(entries = KV_PUBLISH_PLAN_ENTRIES) {
  const valuesByKey = Object.create(null);
  const calls = [];
  for (const entry of entries) {
    validateKVPublishEntry(entry);
    valuesByKey[entry.key] = entry.value_json;
  }
  return {
    calls,
    async get(key) {
      calls.push(key);
      return Object.prototype.hasOwnProperty.call(valuesByKey, key)
        ? valuesByKey[key]
        : null;
    },
  };
}
