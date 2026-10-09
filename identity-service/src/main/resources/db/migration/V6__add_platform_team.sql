-- I6b: the platform team. Its id is a constant of the code (PlatformTeam.ID): holding user:manage in THIS team makes a user
-- a platform administrator (user list, deactivation, new teams and roles, the login audit). Every other team administers itself.
INSERT INTO team (id, name, created_at) VALUES ('00000000-0000-7000-8000-000000000001', 'platform', now());