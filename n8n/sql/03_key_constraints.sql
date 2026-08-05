-- PK/UQ 제약 + 구성 컬럼 / key constraints with member columns
-- W1이 행을 {name, type, object_id, columns: []}로 그룹핑 → catalog.json key_constraints[]
-- 객체 창(window) 분할 — 생성기가 {{OBJ_OFFSET}}/{{OBJ_LIMIT}}를 치환 (W1a는 webhook 값, W1은 전체)
-- windowed by object slice; the generator substitutes the placeholders
DECLARE @o_offset int = {{OBJ_OFFSET}};
DECLARE @o_limit int = {{OBJ_LIMIT}};
SELECT kc.name,
       CASE kc.type WHEN 'PK' THEN 'pk' ELSE 'uq' END AS [type],
       kc.parent_object_id AS object_id,
       col.name AS column_name,
       ic.key_ordinal
FROM sys.key_constraints kc
JOIN sys.index_columns ic
  ON kc.parent_object_id = ic.object_id AND kc.unique_index_id = ic.index_id
JOIN sys.columns col
  ON ic.object_id = col.object_id AND ic.column_id = col.column_id
WHERE kc.parent_object_id IN (
    SELECT object_id FROM sys.objects WHERE type IN ('U', 'V')
    ORDER BY object_id OFFSET @o_offset ROWS FETCH NEXT @o_limit ROWS ONLY
)
ORDER BY kc.name, ic.key_ordinal;
