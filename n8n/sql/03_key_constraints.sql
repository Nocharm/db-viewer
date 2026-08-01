-- PK/UQ 제약 + 구성 컬럼 / key constraints with member columns
-- W1이 행을 {name, type, object_id, columns: []}로 그룹핑 → catalog.json key_constraints[]
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
ORDER BY kc.name, ic.key_ordinal;
