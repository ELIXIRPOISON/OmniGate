-- Sliding-window log rate limiter (docs/05 §1.2, ADR-002). One atomic call per request.
--
-- KEYS[1]        = throttle:{principal}      (checked first: a throttled principal never touches a bucket)
-- KEYS[2..b+1]   = rl:{policyId}:{principal} (one bucket per applicable policy, e.g. route + anon cap)
-- KEYS[b+2]      = optional cache key: when present and it exists, the request is a cache hit that must
--                  not be counted (RL_COUNT_CACHE_HITS=false)
-- ARGV[1]        = now_ms
-- ARGV[2]        = member (now_ms:requestId)
-- ARGV[3]        = b, the number of buckets
-- ARGV[2i+2]     = window_ms for bucket i        (i = 1..b)
-- ARGV[2i+3]     = max for bucket i
--
-- returns { throttle_ttl_ms, allowed } when throttled, otherwise
--         { throttle_ttl_ms, allowed, remaining_1, reset_ms_1, retry_after_ms_1, remaining_2, ... }
-- A request is allowed only if every bucket has room; then it is recorded in every bucket.
-- A denied request consumes nothing, so a burst cannot lock the principal out for longer than the window.
local now     = tonumber(ARGV[1])
local member  = ARGV[2]
local buckets = tonumber(ARGV[3])

local ttl = redis.call('PTTL', KEYS[1])
if ttl > 0 or ttl == -1 then
  return { ttl, 0 }
end

local consume = true
local cacheKey = KEYS[buckets + 2]
if cacheKey and redis.call('EXISTS', cacheKey) == 1 then
  consume = false
end

local counts  = {}
local allowed = 1
for i = 1, buckets do
  local key    = KEYS[i + 1]
  local window = tonumber(ARGV[2 * i + 2])
  local max    = tonumber(ARGV[2 * i + 3])
  redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
  counts[i] = redis.call('ZCARD', key)
  if consume and counts[i] >= max then allowed = 0 end
end

local out = { ttl, allowed }
for i = 1, buckets do
  local key    = KEYS[i + 1]
  local window = tonumber(ARGV[2 * i + 2])
  local max    = tonumber(ARGV[2 * i + 3])
  if allowed == 1 and consume then
    redis.call('ZADD', key, now, member)
    counts[i] = counts[i] + 1
  end
  redis.call('PEXPIRE', key, window + 1000)
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local reset = now + window
  if oldest[2] then reset = tonumber(oldest[2]) + window end
  local remaining = max - counts[i]
  if remaining < 0 then remaining = 0 end
  local retry = 0
  if allowed == 0 and counts[i] >= max then
    retry = reset - now
    if retry < 1 then retry = 1 end
  end
  out[#out + 1] = remaining
  out[#out + 1] = reset
  out[#out + 1] = retry
end
return out
