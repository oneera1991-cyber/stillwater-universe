/** Minimal server-side Upstash/Vercel KV Redis REST client; never import from client components. */
export async function redisCommand<T = unknown>(command: unknown[]): Promise<T> {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) throw new Error('KV/Upstash Redis is not configured')

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
    cache: 'no-store',
    signal: AbortSignal.timeout(1500),
  })
  if (!response.ok) throw new Error('Redis request failed')
  const result = await response.json() as { result?: T; error?: string }
  if (result.error) throw new Error('Redis command failed')
  return result.result as T
}
