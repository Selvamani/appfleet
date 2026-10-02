-- KEYS[1] = bucket key; ARGV[1] = capacity (tokens); ARGV[2] = refill rate (tokens per second)
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])

local t = redis.call('TIME')                                   -- Redis server clock: one clock for every app instance
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(bucket[1]) or capacity                 -- no key: a full bucket
local ts = tonumber(bucket[2]) or now

tokens = math.min(capacity, tokens + (now - ts) / 1000 * rate)

local allowed = 0
local retry_ms = 0
if tokens >= 1 then
    tokens = tokens - 1
    allowed = 1
else
    retry_ms = math.ceil((1 - tokens) / rate * 1000)
end

redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / rate * 1000))   -- idle long enough to be full again: drop it

-- Lua numbers become Redis integers on return (fractions are truncated), so return integers only
return {allowed, math.floor(tokens), retry_ms}