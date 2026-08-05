-- objects: 테이블·뷰 + 행수 / tables & views with row counts
-- contract keys → catalog.json objects[]: object_id, schema, name, type, row_count
-- 페이지 창 — 서비스가 offset/limit을 넘긴다 / the service drives paging
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
    ORDER BY object_id OFFSET {{OFFSET}} ROWS FETCH NEXT {{LIMIT}} ROWS ONLY
);
