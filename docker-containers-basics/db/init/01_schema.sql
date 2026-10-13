-- Starter schema and demo data.
-- Runs once: on the first initialization of an empty data directory (see db/Dockerfile).

CREATE TABLE IF NOT EXISTS items (
    id          SERIAL PRIMARY KEY,
    title       TEXT        NOT NULL,
    description TEXT        NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO items (title, description) VALUES
    ('Starter row #1', 'Created by db/init/01_schema.sql during database initialization'),
    ('Starter row #2', 'These rows live in the containers-basics-pgdata volume'),
    ('Starter row #3', 'Restarting the containers does not remove them');

CREATE INDEX IF NOT EXISTS items_created_at_idx ON items (created_at DESC);
