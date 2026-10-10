-- Down for 0002_app_role: revokes this database's grants to spareon_app.
-- The role itself is NOT dropped: roles are cluster-wide and other databases may use it.
-- REVOKE CREATE ON SCHEMA public FROM PUBLIC is not undone (re-opening the schema is never wanted;
-- on PostgreSQL 15+ it is the default anyway).
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM spareon_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM spareon_app;
REVOKE USAGE ON SCHEMA public FROM spareon_app;
