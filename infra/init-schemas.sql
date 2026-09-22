-- Schema per service, one Postgres instance (Build Guide: "then be able to
-- say in production I'd split them; here the isolation boundary is what
-- matters"). No service reads another service's schema — ever.
CREATE SCHEMA IF NOT EXISTS control;
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS task;
CREATE SCHEMA IF NOT EXISTS query;
