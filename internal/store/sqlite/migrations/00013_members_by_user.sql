-- +goose Up
-- The body of this section is internal/store/sqlite/schema/011_members_by_user.sql, verbatim.
-- internal/store/schema_test.go asserts that, because sqlc reads the schema directory and
-- goose reads this file: if they drift, sqlc generates against a schema the database does
-- not have.

-- 011_members_by_user.sql: the user-to-communities index GET /v1/communities reads through
-- (dilla-web-1 task 8, L-SQL-01), migration 00013_members_by_user.sql. The primary key of
-- members is (community_id, user_id), which serves "the members of a community" and not "the
-- communities of a user": without this index ListCommunitiesForUser reads every membership row of
-- the instance.
CREATE INDEX members_by_user ON members (user_id, community_id);

-- +goose Down
DROP INDEX members_by_user;
