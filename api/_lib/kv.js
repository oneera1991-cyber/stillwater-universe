/* Shared Upstash REST client for app state (membership, device memory).
   Same client as the Payhip adapter (KV_REST_API_URL / KV_REST_API_TOKEN via log.js redisFromEnv);
   dev/tests point it at dev/upstash-mock.mjs or setRedisForTesting(). Never used for telemetry keys. */
export { redis, setRedisForTesting } from "./payment/payhip.js";
