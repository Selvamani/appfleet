-- 20 applications: first 3 are "hot" (own ~70% of task volume), rest are "quiet"
WITH app_weights AS (
    SELECT id, row_number() OVER (ORDER BY created_at) AS rn
    FROM application
),
     weighted AS (
         SELECT id,
                CASE WHEN rn <= 3 THEN 100 ELSE 1 END AS weight
         FROM app_weights
     )
-- pick a weighted-random application per generated task by expanding weight into a pool,
-- then sampling from the pool uniformly
SELECT id FROM (
                   SELECT id, generate_series(1, weight) FROM weighted
               ) pool
ORDER BY random()
    LIMIT 1;