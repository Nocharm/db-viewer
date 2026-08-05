-- 객체 수준 뷰 의존성 / object-level view dependencies → view_deps.json deps[] (1차)
-- referenced_id IS NULL = 미해석 참조 — 버리지 말고 플래그로 보존해 Phase 2로 이관
-- NULL referenced_id = unresolved ref; keep it flagged, defer to Phase 2
SELECT d.referencing_id AS view_object_id,
       d.referenced_id AS referenced_object_id,
       d.referenced_database_name AS referenced_database,
       ISNULL(d.referenced_schema_name + '.', '') + d.referenced_entity_name AS referenced_name,
       CAST(NULL AS sysname) AS referenced_column,
       CASE WHEN d.referenced_id IS NULL THEN 0 ELSE 1 END AS is_resolved
FROM sys.sql_expression_dependencies d
JOIN sys.objects o ON d.referencing_id = o.object_id AND o.type = 'V'
WHERE d.referencing_id IN ({{ID_LIST}});
