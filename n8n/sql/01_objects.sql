-- objects: 테이블·뷰 + 행수 / tables & views with row counts
-- contract keys → catalog.json objects[]: object_id, schema, name, type, row_count
-- 객체 창(window) 분할 — 생성기가 {{OBJ_OFFSET}}/{{OBJ_LIMIT}}를 치환 (W1a는 webhook 값, W1은 전체)
-- windowed by object slice; the generator substitutes the placeholders
DECLARE @o_offset int = {{OBJ_OFFSET}};
DECLARE @o_limit int = {{OBJ_LIMIT}};
SELECT o.object_id,
       s.name AS [schema],
       o.name,
       CASE o.type WHEN 'U' THEN 'table' ELSE 'view' END AS [type],
       ps.row_count
FROM sys.objects o
JOIN sys.schemas s ON o.schema_id = s.schema_id
OUTER APPLY (
    -- heap(0)·clustered(1)만 합산 — 보조 인덱스 중복 방지 / avoid double counting secondary indexes
    SELECT SUM(p.row_count) AS row_count
    FROM sys.dm_db_partition_stats p
    WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)
) ps
WHERE o.type IN ('U', 'V')
  AND o.object_id IN (
    SELECT object_id FROM sys.objects WHERE type IN ('U', 'V')
    ORDER BY object_id OFFSET @o_offset ROWS FETCH NEXT @o_limit ROWS ONLY
);
