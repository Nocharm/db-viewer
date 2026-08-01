-- [1] FK 개수 / foreign key count — FK가 적을수록 추론(Phase 3~4) 의존도가 커진다
SELECT COUNT(*) AS fk_count FROM sys.foreign_keys;
