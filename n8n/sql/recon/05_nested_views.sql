-- [5] 중첩 뷰 / nested views — lineage 재귀 깊이·규모 가늠
SELECT COUNT(*) AS view_on_view
FROM sys.sql_expression_dependencies d
JOIN sys.objects o ON d.referencing_id = o.object_id AND o.type = 'V'
JOIN sys.objects r ON d.referenced_id  = r.object_id AND r.type = 'V';
