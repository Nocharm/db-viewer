-- columns: 테이블·뷰의 전체 컬럼 / all columns of tables and views
-- contract keys → catalog.json columns[]: object_id, name, ordinal, data_type, max_length, is_nullable, is_computed
-- 객체 창(window) 분할 — 생성기가 {{OBJ_OFFSET}}/{{OBJ_LIMIT}}를 치환 (W1a는 webhook 값, W1은 전체)
-- windowed by object slice; the generator substitutes the placeholders
DECLARE @o_offset int = {{OBJ_OFFSET}};
DECLARE @o_limit int = {{OBJ_LIMIT}};
SELECT c.object_id,
       c.name,
       c.column_id AS ordinal,
       t.name AS data_type,
       c.max_length,          -- varchar(max) 등은 -1 / -1 for MAX types
       c.is_nullable,
       c.is_computed
FROM sys.columns c
JOIN sys.types t ON c.user_type_id = t.user_type_id
JOIN sys.objects o ON c.object_id = o.object_id
WHERE o.type IN ('U', 'V')
  AND c.object_id IN (
    SELECT object_id FROM sys.objects WHERE type IN ('U', 'V')
    ORDER BY object_id OFFSET @o_offset ROWS FETCH NEXT @o_limit ROWS ONLY
);
