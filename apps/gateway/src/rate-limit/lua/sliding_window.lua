-- Sliding-window log rate limiter (docs/05 §1.2, ADR-002). One atomic call per request.
--
-- KEYS[1]      = throttle:{principal}      (checked first: a throttled principal never touches a bucket)
-- KEYS[2..n]   = rl:{policyId}:{principal} (one bucket per applicable policy, e.g. route + anon cap)
-- ARGV[1]      = now_ms
-- ARGV[2]      = member (now_ms:requestId)
-- ARGV[2i+1]   = window_ms for bucket i
-- ARGV[2i+2]   = max for bucket i
--
-- returns { throttle_ttl_ms, allowed } when throttled, otherwise
--         { throttle_ttl_ms, allowed, remaining_1, reset_ms_1, retry_after_ms_1, remaining_2, ... }
-- A request is allowed only if every bucket has room; then it is recorded in every bucket.
-- A denied request consumes nothing, so a burst cannot lock the principal out for longer than the window.
local now    = tonumber(ARGV[1])
local member = ARGV[2]

local ttl = redis.call('PTTL', KEYS[1])
if ttl > 0 or ttl == -1 then
  return { ttl, 0 }
end

local buckets = #KEYS - 1
local counts  = {}
local allowed = 1
for i = 1, buckets do
  local key    = KEYS[i + 1]
  local window = tonumber(ARGV[2 * i + 1])
  local max    = tonumber(ARGV[2 * i + 2])
  redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
  counts[i] = redis.call('ZCARD', key)
  if counts[i] >= max then allowed = 0 end
end

local out = { ttl, allowed }
for i = 1, buckets do
  local key    = KEYS[i + 1]
  local window = tonumber(ARGV[2 * i + 1])
  local max    = tonumber(ARGV[2 * i + 2])
  if allowed == 1 then
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
