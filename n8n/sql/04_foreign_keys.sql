-- FK 제약 + 컬럼 페어 / foreign keys with column pairs
-- W1이 행을 {name, src_object_id, tgt_object_id, columns: [{src_column, tgt_column}]}로 그룹핑
SELECT fk.name,
       fk.parent_object_id AS src_object_id,
       fk.referenced_object_id AS tgt_object_id,
       sc.name AS src_column,
       tc.name AS tgt_column,
       fkc.constraint_column_id
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
JOIN sys.columns sc
  ON fkc.parent_object_id = sc.object_id AND fkc.parent_column_id = sc.column_id
JOIN sys.columns tc
  ON fkc.referenced_object_id = tc.object_id AND fkc.referenced_column_id = tc.column_id
ORDER BY fk.name, fkc.constraint_column_id;
