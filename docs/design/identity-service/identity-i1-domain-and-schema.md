# identity-service — I1: domain and schema

**Spec:** [02-IDENTITY-SERVICE.md](../../specs/project/02-IDENTITY-SERVICE.md), *Domain model* · Step **I1** of [identity-service-plan.md](identity-service-plan.md) · Companion: [control-api-s4-1-jwt-validation.md](../control-api/control-api-s4-1-jwt-validation.md) (the claim contract that I2 will issue), [control-api-s4-4-idor.md](../control-api/control-api-s4-4-idor.md) (the team-scoped permissions this model feeds). **Status: built and closed 2026-10-06. The code in sections 5 and 6 was run on a scratch copy first (section 8), then typed into the real tree by hand: 27 tests green (section 10).**

I1 builds the data model and nothing that uses it over HTTP: users, the permission vocabulary, roles as bundles, teams, and the scoped grant (a role held on a team). It also builds the two pieces I2 will call to turn a user's grants into token claims: the role hierarchy and a resolver from role name to permissions. There are no endpoints and no tokens in this step.

## 1. What already exists

- A skeleton: `IdentityServiceApplication`, `application.yml` (port 8082, datasource with `currentSchema=identity`, Flyway on schema `identity`, Redis), and `V1__init.sql`, which holds only comments.
- Your edits from the plan (section 5.1, item 4) are in: no Kafka in the pom, `spring-boot-flyway` and `spring-boot-testcontainers` added. Verified on the scratch copy: with exactly your pom and yml, the 27 tests below pass.
- `infra/init-schemas.sql` creates the schema `identity` on the shared Postgres. Under Testcontainers the schema does not exist, so Flyway creates it (it does by default; `control-api` relies on the same).
- `common-security` is on the classpath but inactive: its auto-configuration only starts when `appfleet.security.jwt.public-key-location` is set, and identity-service does not set it. Without a chain of its own, Spring Boot would protect every path with a generated password, so I1 writes a minimal chain (decision 9).
- control-api's conventions apply: singular table names, UUIDv7 ids generated in the application, `timestamptz`, constraints in the database with names that tests assert (`uq_...`, `ck_...`), `ddl-auto: validate`, `open-in-view: false`.

## 2. Behaviour

| Thing | Behaviour |
|---|---|
| Users | Created with an email (stored trimmed and lower case), a display name and a password hash; `ACTIVE` or `DEACTIVATED`; deactivating twice changes nothing; no delete path |
| Permissions | Eight seeded atoms in the shape `resource:action` (the database refuses any other shape) |
| Roles | `VIEWER`, `DEPLOYER`, `OPERATOR`, `ADMIN`; each holds only its own permissions |
| Hierarchy | `ADMIN > OPERATOR > DEPLOYER > VIEWER`, in code |
| Resolver | `permissionsFor("DEPLOYER")` returns the permissions of `DEPLOYER` and `VIEWER`; an unknown role is refused |
| Grants | `team_membership(user, team, role)`, one role per user per team; one query returns all grants of a user as (team id, role name) |
| HTTP | `/actuator/health` and `/actuator/info` answer; every other path answers 403 |

The seeded bundles (each role's own permissions only, the rest is inherited):

| Role | Own permissions | Effective permissions |
|---|---|---|
| `VIEWER` | `application:read`, `deployment:read` | the same two |
| `DEPLOYER` | `application:create`, `deployment:create` | plus the VIEWER two |
| `OPERATOR` | `deployment:rollback`, `node:drain` | plus DEPLOYER and VIEWER |
| `ADMIN` | `catalog:publish`, `user:manage` | all eight |

The five permissions control-api enforces today (`application:create`, `application:read`, `deployment:create`, `deployment:read`, `deployment:rollback`) are all in the vocabulary, so a token built from these roles works with control-api unchanged.

## 3. Decisions

1. **Tables start at `V2`.** `V1__init.sql` stays as it is (plan question 8). Only the six core tables are created here; `refresh_token`, `api_key` and `login_audit` come with I3, I7 and I5.
2. **The table is `app_user`, not `user`.** `user` is a reserved word in Postgres.
3. **Email is stored lower case, and the database enforces it.** `ck_app_user_email_lower` (`email = lower(email)`) plus `uq_app_user_email`. Rejected: `citext` (needs an extension and a privilege) and a unique index on `lower(email)` (works, but then a row with a mixed-case email can exist and every query must remember to lower-case). With the check, the only way in is the normalised form, and `AppUser.normalize` is the single place that produces it.
4. **Deactivation is a state, and the database checks it.** `status` is `ACTIVE` or `DEACTIVATED`, and `ck_app_user_deactivated` says `DEACTIVATED` if and only if `deactivated_at` is set. `UserRepository` extends `Repository`, not `CrudRepository`, so it has no delete method; a test pins that. A database trigger against `DELETE` was rejected for I1: a foreign key from the login audit (I5) will protect users that have history, and a trigger would also block test clean-up.
5. **Permission names have a shape.** `ck_permission_name`: `^[a-z]+:[a-z]+$`. That is the same pattern `control-api`'s OpenAPI customizer uses to read `@PreAuthorize`, so a permission that identity could define is always one control-api can document.
6. **Roles are rows, hierarchy is code.** A new role is a new row with its permissions and needs no code, but placing it in the order needs one line in `RoleHierarchyConfig`. A test checks that the hierarchy and the database name the same four roles, so a role added to one and not the other fails the build.
7. **`role_permission` holds only a role's own permissions.** Inheritance is not stored. `PermissionResolver` takes the roles the hierarchy reaches from the given role and unions their permissions. Rejected: storing the closure, which needs a rebuild on every hierarchy change.
8. **One role per user per team** (`uq_team_membership_user_team`). Because the hierarchy makes a higher role include a lower one, a second role on the same team would add nothing. The token's `teams` map (I2) has one list per team, which matches.
9. **A minimal security chain now.** Health and info are open, everything else is `denyAll()`, stateless, CSRF off. I2 adds the auth endpoints and the JWKS path to this class. The answer for a refused request is 403 and not a problem body; the problem-shape handlers arrive with I2 (plan question 5).
10. **Seed ids use `gen_random_uuid()`,** not UUIDv7. Nothing outside the database refers to a seeded id; code finds roles and permissions by name.
11. **Read-only roles and permissions in I1.** The entities have no public constructor and no setters. The admin API (I6) decides how they change.
12. **Resolver cost.** `permissionsFor` loads all four roles with their permissions in one select, on every call. That is fine for I2's per-login use; a cache is an I2 decision if the numbers ask for it.
13. **`Uuidv7` is copied into this module,** not shared. `common-events` is for event contracts, and a utility module for one 25-line class is more than it saves.

## 4. Changes to your existing files

Your pom edits are done. One more edit, in `identity-service/src/main/resources/application.yml`: your file does not set `open-in-view: false` or the Hibernate default schema, and control-api does. Under `spring:` replace

```yaml
  jpa:
    hibernate:
      ddl-auto: validate
```
with

```yaml
  jpa:
    open-in-view: false
    hibernate:
      ddl-auto: validate
    properties:
      hibernate:
        default_schema: identity
```
(The 27 tests also pass without this change, because the connection URL already sets `currentSchema=identity`; the change keeps the two services alike and silences the open-in-view warning.)

## 5. Main code

New packages under `io.appfleet.identity`: `common`, `user`, `rbac`, `team`, `config`.

### 5.1 The migration

**`identity-service/src/main/resources/db/migration/V2__add_users_roles_teams.sql`**

```sql
-- I1: the users, the RBAC vocabulary and the scoped grants. Refresh tokens, API keys and the
-- login audit get their own migrations in the steps that use them (I3, I5, I7).

CREATE TABLE app_user (
    id              uuid PRIMARY KEY,
    email           text NOT NULL,
    display_name    text NOT NULL,
    password_hash   text NOT NULL,
    status          text NOT NULL CHECK (status IN ('ACTIVE', 'DEACTIVATED')),
    created_at      timestamptz NOT NULL,
    deactivated_at  timestamptz,
    CONSTRAINT uq_app_user_email UNIQUE (email),
    CONSTRAINT ck_app_user_email_lower CHECK (email = lower(email)),
    CONSTRAINT ck_app_user_deactivated CHECK ((status = 'DEACTIVATED') = (deactivated_at IS NOT NULL))
);

CREATE TABLE permission (
    id          uuid PRIMARY KEY,
    name        text NOT NULL,
    description text NOT NULL,
    CONSTRAINT uq_permission_name UNIQUE (name),
    CONSTRAINT ck_permission_name CHECK (name ~ '^[a-z]+:[a-z]+$')
);

CREATE TABLE role (
    id          uuid PRIMARY KEY,
    name        text NOT NULL,
    description text NOT NULL,
    CONSTRAINT uq_role_name UNIQUE (name)
);

CREATE TABLE role_permission (
    role_id       uuid NOT NULL REFERENCES role(id),
    permission_id uuid NOT NULL REFERENCES permission(id),
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE team (
    id         uuid PRIMARY KEY,
    name       text NOT NULL,
    created_at timestamptz NOT NULL,
    CONSTRAINT uq_team_name UNIQUE (name)
);

-- the scoped grant: one role per user per team
CREATE TABLE team_membership (
    id         uuid PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES app_user(id),
    team_id    uuid NOT NULL REFERENCES team(id),
    role_id    uuid NOT NULL REFERENCES role(id),
    created_at timestamptz NOT NULL,
    CONSTRAINT uq_team_membership_user_team UNIQUE (user_id, team_id)
);
CREATE INDEX idx_team_membership_team ON team_membership (team_id);

-- Seed: permissions are the atoms, roles are bundles. Each role lists only its OWN permissions;
-- what a role inherits comes from the RoleHierarchy in code (ADMIN > OPERATOR > DEPLOYER > VIEWER).
INSERT INTO permission (id, name, description) VALUES
    (gen_random_uuid(), 'application:read',    'List and read applications and releases'),
    (gen_random_uuid(), 'deployment:read',     'Read deployments and their task history'),
    (gen_random_uuid(), 'application:create',  'Create applications and releases'),
    (gen_random_uuid(), 'deployment:create',   'Request a deployment'),
    (gen_random_uuid(), 'deployment:rollback', 'Roll a deployment back'),
    (gen_random_uuid(), 'node:drain',          'Drain a node'),
    (gen_random_uuid(), 'catalog:publish',     'Publish to the image catalogue'),
    (gen_random_uuid(), 'user:manage',          'Manage users, roles and teams');

INSERT INTO role (id, name, description) VALUES
    (gen_random_uuid(), 'VIEWER',   'Read-only'),
    (gen_random_uuid(), 'DEPLOYER', 'Creates applications and deployments'),
    (gen_random_uuid(), 'OPERATOR', 'Rolls back and drains nodes'),
    (gen_random_uuid(), 'ADMIN',    'Publishes to the catalogue and manages users');

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
    ('VIEWER',   'application:read'),
    ('VIEWER',   'deployment:read'),
    ('DEPLOYER', 'application:create'),
    ('DEPLOYER', 'deployment:create'),
    ('OPERATOR', 'deployment:rollback'),
    ('OPERATOR', 'node:drain'),
    ('ADMIN',    'catalog:publish'),
    ('ADMIN',    'user:manage')
) AS m(role_name, permission_name)
JOIN role r ON r.name = m.role_name
JOIN permission p ON p.name = m.permission_name;
```

### 5.2 Ids

**`identity-service/src/main/java/io/appfleet/identity/common/Uuidv7.java`**

```java
package io.appfleet.identity.common;

import java.security.SecureRandom;
import java.util.UUID;

/** Time-ordered UUIDs, the same scheme as control-api: v7, so primary keys insert in roughly increasing order. */
public final class Uuidv7 {

    private static final SecureRandom RANDOM = new SecureRandom();

    private Uuidv7() {}

    public static UUID generate() {
        byte[] value = new byte[16];
        RANDOM.nextBytes(value);
        long timestamp = System.currentTimeMillis();

        value[0] = (byte) (timestamp >>> 40);
        value[1] = (byte) (timestamp >>> 32);
        value[2] = (byte) (timestamp >>> 24);
        value[3] = (byte) (timestamp >>> 16);
        value[4] = (byte) (timestamp >>> 8);
        value[5] = (byte) timestamp;
        value[6] = (byte) (0x70 | (value[6] & 0x0F));   // version 7
        value[8] = (byte) (0x80 | (value[8] & 0x3F));   // variant 10

        long msb = 0;
        long lsb = 0;
        for (int i = 0; i < 8; i++) msb = (msb << 8) | (value[i] & 0xFF);
        for (int i = 8; i < 16; i++) lsb = (lsb << 8) | (value[i] & 0xFF);
        return new UUID(msb, lsb);
    }
}
```

### 5.3 Users

**`identity-service/src/main/java/io/appfleet/identity/user/UserStatus.java`**

```java
package io.appfleet.identity.user;

public enum UserStatus {
    ACTIVE,
    DEACTIVATED
}
```

**`identity-service/src/main/java/io/appfleet/identity/user/AppUser.java`**

```java
package io.appfleet.identity.user;

import io.appfleet.identity.common.Uuidv7;
import jakarta.persistence.*;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Locale;
import java.util.UUID;

@Entity
@Table(name = "app_user")   // "user" is a reserved word in Postgres
public class AppUser {

    @Id
    private UUID id;

    @Column(nullable = false, unique = true)
    private String email;

    @Column(name = "display_name", nullable = false)
    private String displayName;

    @Column(name = "password_hash", nullable = false)
    private String passwordHash;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private UserStatus status;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "deactivated_at")
    private Instant deactivatedAt;

    protected AppUser() {}

    public AppUser(String email, String displayName, String passwordHash) {
        this.id = Uuidv7.generate();
        this.email = normalize(email);
        this.displayName = displayName;
        this.passwordHash = passwordHash;
        this.status = UserStatus.ACTIVE;
        this.createdAt = Instant.now().truncatedTo(ChronoUnit.MICROS);
    }

    /** The one place an email is normalised; the database refuses anything that is not already lower case. */
    public static String normalize(String email) {
        return email.trim().toLowerCase(Locale.ROOT);
    }

    /** Users are deactivated, never deleted (audit integrity). Calling it twice changes nothing. */
    public void deactivate() {
        if (status == UserStatus.DEACTIVATED) return;
        status = UserStatus.DEACTIVATED;
        deactivatedAt = Instant.now().truncatedTo(ChronoUnit.MICROS);
    }

    public UUID getId() { return id; }
    public String getEmail() { return email; }
    public String getDisplayName() { return displayName; }
    public String getPasswordHash() { return passwordHash; }
    public UserStatus getStatus() { return status; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getDeactivatedAt() { return deactivatedAt; }
    public boolean isActive() { return status == UserStatus.ACTIVE; }
}
```

**`identity-service/src/main/java/io/appfleet/identity/user/UserRepository.java`**

```java
package io.appfleet.identity.user;

import org.springframework.data.repository.Repository;

import java.util.Optional;
import java.util.UUID;

/**
 * Deliberately NOT a CrudRepository: it has no delete method, so a user cannot be hard-deleted through it.
 * UserRepositoryTest.userRepository_hasNoDeleteMethod pins that.
 */
public interface UserRepository extends Repository<AppUser, UUID> {

    AppUser save(AppUser user);

    Optional<AppUser> findById(UUID id);

    /** The email must already be normalised (AppUser.normalize). */
    Optional<AppUser> findByEmail(String email);

    boolean existsByEmail(String email);
}
```

### 5.4 Roles, permissions, hierarchy, resolver

**`identity-service/src/main/java/io/appfleet/identity/rbac/Permission.java`**

```java
package io.appfleet.identity.rbac;

import jakarta.persistence.*;

import java.util.UUID;

/** An atom of authority, for example deployment:create. Read-only in I1; the admin API (I6) will change it. */
@Entity
@Table(name = "permission")
public class Permission {

    @Id
    private UUID id;

    @Column(nullable = false, unique = true)
    private String name;

    @Column(nullable = false)
    private String description;

    protected Permission() {}

    public UUID getId() { return id; }
    public String getName() { return name; }
    public String getDescription() { return description; }
}
```

**`identity-service/src/main/java/io/appfleet/identity/rbac/Role.java`**

```java
package io.appfleet.identity.rbac;

import jakarta.persistence.*;

import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

/** A named bundle of permissions. Holds only its own permissions; inherited ones come from the RoleHierarchy. */
@Entity
@Table(name = "role")
public class Role {

    @Id
    private UUID id;

    @Column(nullable = false, unique = true)
    private String name;

    @Column(nullable = false)
    private String description;

    @ManyToMany(fetch = FetchType.LAZY)
    @JoinTable(name = "role_permission",
            joinColumns = @JoinColumn(name = "role_id"),
            inverseJoinColumns = @JoinColumn(name = "permission_id"))
    private Set<Permission> permissions = new HashSet<>();

    protected Role() {}

    public UUID getId() { return id; }
    public String getName() { return name; }
    public String getDescription() { return description; }
    public Set<Permission> getPermissions() { return permissions; }
}
```

**`identity-service/src/main/java/io/appfleet/identity/rbac/RoleRepository.java`**

```java
package io.appfleet.identity.rbac;

import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.repository.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface RoleRepository extends Repository<Role, UUID> {

    Optional<Role> findByName(String name);

    /** Every role with its permissions in ONE select, so the resolver never lazy-loads. */
    @EntityGraph(attributePaths = "permissions")
    List<Role> findAllBy();
}
```

**`identity-service/src/main/java/io/appfleet/identity/rbac/PermissionRepository.java`**

```java
package io.appfleet.identity.rbac;

import org.springframework.data.repository.Repository;

import java.util.List;
import java.util.UUID;

public interface PermissionRepository extends Repository<Permission, UUID> {

    List<Permission> findAllByOrderByNameAsc();
}
```

**`identity-service/src/main/java/io/appfleet/identity/rbac/RoleHierarchyConfig.java`**

```java
package io.appfleet.identity.rbac;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.access.hierarchicalroles.RoleHierarchy;
import org.springframework.security.access.hierarchicalroles.RoleHierarchyImpl;

@Configuration
public class RoleHierarchyConfig {

    /** The order of the roles. RoleHierarchyTest checks that these four names are exactly the roles in the database. */
    @Bean
    RoleHierarchy roleHierarchy() {
        return RoleHierarchyImpl.fromHierarchy("""
                ADMIN > OPERATOR
                OPERATOR > DEPLOYER
                DEPLOYER > VIEWER
                """);
    }
}
```

**`identity-service/src/main/java/io/appfleet/identity/rbac/PermissionResolver.java`**

```java
package io.appfleet.identity.rbac;

import org.springframework.security.access.hierarchicalroles.RoleHierarchy;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;

/**
 * Turns a role name into the permissions it grants, including everything the role hierarchy implies.
 * The token issuer (I2) calls this once per team membership.
 */
@Service
public class PermissionResolver {

    private final RoleHierarchy roleHierarchy;
    private final RoleRepository roles;

    public PermissionResolver(RoleHierarchy roleHierarchy, RoleRepository roles) {
        this.roleHierarchy = roleHierarchy;
        this.roles = roles;
    }

    @Transactional(readOnly = true)
    public Set<String> permissionsFor(String roleName) {
        Map<String, Role> byName = roles.findAllBy().stream().collect(Collectors.toMap(Role::getName, r -> r));
        if (!byName.containsKey(roleName)) throw new IllegalArgumentException("unknown role: " + roleName);

        List<String> reachable = roleHierarchy
                .getReachableGrantedAuthorities(List.of(new SimpleGrantedAuthority(roleName)))
                .stream().map(GrantedAuthority::getAuthority).toList();

        Set<String> permissions = new TreeSet<>();
        for (String name : new HashSet<>(reachable)) {
            Role role = byName.get(name);
            if (role == null) throw new IllegalStateException("role hierarchy names a role that is not in the database: " + name);
            role.getPermissions().forEach(p -> permissions.add(p.getName()));
        }
        return permissions;
    }
}
```

### 5.5 Teams and grants

**`identity-service/src/main/java/io/appfleet/identity/team/Team.java`**

```java
package io.appfleet.identity.team;

import io.appfleet.identity.common.Uuidv7;
import jakarta.persistence.*;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;

@Entity
@Table(name = "team")
public class Team {

    @Id
    private UUID id;

    @Column(nullable = false, unique = true)
    private String name;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected Team() {}

    public Team(String name) {
        this.id = Uuidv7.generate();
        this.name = name;
        this.createdAt = Instant.now().truncatedTo(ChronoUnit.MICROS);
    }

    public UUID getId() { return id; }
    public String getName() { return name; }
    public Instant getCreatedAt() { return createdAt; }
}
```

**`identity-service/src/main/java/io/appfleet/identity/team/TeamMembership.java`**

```java
package io.appfleet.identity.team;

import io.appfleet.identity.common.Uuidv7;
import io.appfleet.identity.rbac.Role;
import io.appfleet.identity.user.AppUser;
import jakarta.persistence.*;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;

/** The scoped grant: this user holds this role on this team. One role per user per team. */
@Entity
@Table(name = "team_membership")
public class TeamMembership {

    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "user_id")
    private AppUser user;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "team_id")
    private Team team;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "role_id")
    private Role role;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected TeamMembership() {}

    public TeamMembership(AppUser user, Team team, Role role) {
        this.id = Uuidv7.generate();
        this.user = user;
        this.team = team;
        this.role = role;
        this.createdAt = Instant.now().truncatedTo(ChronoUnit.MICROS);
    }

    public UUID getId() { return id; }
    public AppUser getUser() { return user; }
    public Team getTeam() { return team; }
    public Role getRole() { return role; }
}
```

**`identity-service/src/main/java/io/appfleet/identity/team/TeamRole.java`**

```java
package io.appfleet.identity.team;

import java.util.UUID;

/** One scoped grant as the token issuer needs it: a team id and a role name, nothing else. */
public record TeamRole(UUID teamId, String roleName) {}
```

**`identity-service/src/main/java/io/appfleet/identity/team/TeamRepository.java`**

```java
package io.appfleet.identity.team;

import org.springframework.data.repository.Repository;

import java.util.Optional;
import java.util.UUID;

public interface TeamRepository extends Repository<Team, UUID> {

    Team save(Team team);

    Optional<Team> findById(UUID id);
}
```

**`identity-service/src/main/java/io/appfleet/identity/team/TeamMembershipRepository.java`**

```java
package io.appfleet.identity.team;

import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.Repository;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.UUID;

public interface TeamMembershipRepository extends Repository<TeamMembership, UUID> {

    TeamMembership save(TeamMembership membership);

    /** All grants of one user in ONE select (membership joined to role); the team id is the foreign key, no team join. */
    @Query("select new io.appfleet.identity.team.TeamRole(m.team.id, m.role.name) "
            + "from TeamMembership m where m.user.id = :userId order by m.team.id")
    List<TeamRole> findGrantsByUserId(@Param("userId") UUID userId);
}
```

### 5.6 The chain

**`identity-service/src/main/java/io/appfleet/identity/config/SecurityConfig.java`**

```java
package io.appfleet.identity.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

/**
 * I1: nothing but the two actuator probes is reachable. Without this chain Spring Boot would protect every path with
 * a generated password. I2 opens /api/v1/auth/** and the JWKS path here; each service writes its own chain.
 */
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    SecurityFilterChain chain(HttpSecurity http) throws Exception {
        http.authorizeHttpRequests(a -> a
                        .requestMatchers("/actuator/health", "/actuator/info").permitAll()
                        .anyRequest().denyAll())
                .csrf(c -> c.disable())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS));
        return http.build();
    }
}
```

## 6. Tests

Under `identity-service/src/test/java/io/appfleet/identity/`. 27 tests in five classes plus a base class. The base class uses one Postgres per JVM and a real HTTP port, because MockMvc would skip the security chain (found in control-api S4.6). Redis is not started before I4, so its health check is switched off for the tests.

**`identity-service/src/test/java/io/appfleet/identity/IdentityIntegrationTest.java`**

```java
package io.appfleet.identity;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;

/**
 * One Postgres per JVM. Real HTTP port, because MockMvc skips the security filter chain (found in control-api S4.6).
 * Redis is not needed before I4, so its health check is switched off rather than starting a container for it.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "management.health.redis.enabled=false",
        "spring.jpa.properties.hibernate.generate_statistics=true"
})
public abstract class IdentityIntegrationTest {

    @ServiceConnection
    static final PostgreSQLContainer<?> postgres =
            new PostgreSQLContainer<>("postgres:16").withUrlParam("currentSchema", "identity");

    static {
        postgres.start();
    }

    @Autowired
    protected JdbcTemplate jdbc;
}
```

**`identity-service/src/test/java/io/appfleet/identity/SchemaAndSeedTest.java`**

```java
package io.appfleet.identity;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import static org.assertj.core.api.Assertions.assertThat;

/** The migration ran, Hibernate's validate accepted the mappings (the context started), and the seed is exactly this. */
class SchemaAndSeedTest extends IdentityIntegrationTest {

    @Test
    void roles_areTheFourSeeded() {
        List<String> roles = jdbc.queryForList("select name from role order by name", String.class);
        assertThat(roles).containsExactly("ADMIN", "DEPLOYER", "OPERATOR", "VIEWER");
    }

    @Test
    void permissions_areTheVocabulary() {
        List<String> permissions = jdbc.queryForList("select name from permission order by name", String.class);
        assertThat(permissions).containsExactly(
                "application:create", "application:read", "catalog:publish", "deployment:create",
                "deployment:read", "deployment:rollback", "node:drain", "user:manage");
    }

    @Test
    void eachRole_holdsOnlyItsOwnPermissions() {
        Map<String, List<String>> own = new TreeMap<>();
        jdbc.query("""
                select r.name as role_name, p.name as permission_name
                from role_permission rp join role r on r.id = rp.role_id join permission p on p.id = rp.permission_id
                order by r.name, p.name
                """, rs -> {
            own.computeIfAbsent(rs.getString("role_name"), k -> new java.util.ArrayList<>()).add(rs.getString("permission_name"));
        });
        assertThat(own).containsOnlyKeys("ADMIN", "DEPLOYER", "OPERATOR", "VIEWER");
        assertThat(own.get("VIEWER")).containsExactly("application:read", "deployment:read");
        assertThat(own.get("DEPLOYER")).containsExactly("application:create", "deployment:create");
        assertThat(own.get("OPERATOR")).containsExactly("deployment:rollback", "node:drain");
        assertThat(own.get("ADMIN")).containsExactly("catalog:publish", "user:manage");
    }
}
```

**`identity-service/src/test/java/io/appfleet/identity/ConstraintTest.java`**

```java
package io.appfleet.identity;

import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The rules live in the database, not only in JPA: each statement below goes around the entities with plain SQL. */
class ConstraintTest extends IdentityIntegrationTest {

    private UUID insertUser(String email) {
        UUID id = UUID.randomUUID();
        jdbc.update("insert into app_user (id, email, display_name, password_hash, status, created_at) "
                + "values (?, ?, 'n', 'h', 'ACTIVE', now())", id, email);
        return id;
    }

    private UUID insertTeam(String name) {
        UUID id = UUID.randomUUID();
        jdbc.update("insert into team (id, name, created_at) values (?, ?, now())", id, name);
        return id;
    }

    private UUID roleId(String name) {
        return jdbc.queryForObject("select id from role where name = ?", UUID.class, name);
    }

    @Test
    void duplicateEmail_isRefused() {
        String email = "dup-" + UUID.randomUUID() + "@x.io";
        insertUser(email);
        assertThatThrownBy(() -> insertUser(email))
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("uq_app_user_email");
    }

    @Test
    void upperCaseEmail_isRefused_soTwoSpellingsCannotCoexist() {
        assertThatThrownBy(() -> insertUser("Mixed-" + UUID.randomUUID() + "@X.io"))
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("ck_app_user_email_lower");
    }

    @Test
    void unknownStatus_isRefused() {
        assertThatThrownBy(() -> jdbc.update("insert into app_user (id, email, display_name, password_hash, status, created_at) "
                + "values (?, ?, 'n', 'h', 'DELETED', now())", UUID.randomUUID(), "s-" + UUID.randomUUID() + "@x.io"))
                .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void deactivatedWithoutATimestamp_isRefused() {
        assertThatThrownBy(() -> jdbc.update("insert into app_user (id, email, display_name, password_hash, status, created_at) "
                + "values (?, ?, 'n', 'h', 'DEACTIVATED', now())", UUID.randomUUID(), "d-" + UUID.randomUUID() + "@x.io"))
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("ck_app_user_deactivated");
    }

    @Test
    void duplicateRoleName_isRefused() {
        assertThatThrownBy(() -> jdbc.update("insert into role (id, name, description) values (?, 'VIEWER', 'again')", UUID.randomUUID()))
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("uq_role_name");
    }

    @Test
    void permissionNameWithoutTheResourceActionShape_isRefused() {
        assertThatThrownBy(() -> jdbc.update("insert into permission (id, name, description) values (?, 'deployment', 'x')", UUID.randomUUID()))
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("ck_permission_name");
        assertThatThrownBy(() -> jdbc.update("insert into permission (id, name, description) values (?, 'Deployment:Create', 'x')", UUID.randomUUID()))
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("ck_permission_name");
    }

    @Test
    void secondRoleForTheSameUserAndTeam_isRefused() {
        UUID user = insertUser("m-" + UUID.randomUUID() + "@x.io");
        UUID team = insertTeam("t-" + UUID.randomUUID());
        String sql = "insert into team_membership (id, user_id, team_id, role_id, created_at) values (?, ?, ?, ?, now())";
        jdbc.update(sql, UUID.randomUUID(), user, team, roleId("VIEWER"));
        assertThatThrownBy(() -> jdbc.update(sql, UUID.randomUUID(), user, team, roleId("ADMIN")))
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("uq_team_membership_user_team");
    }

    @Test
    void membershipWithAnUnknownRole_isRefused() {
        UUID user = insertUser("f-" + UUID.randomUUID() + "@x.io");
        UUID team = insertTeam("f-" + UUID.randomUUID());
        assertThatThrownBy(() -> jdbc.update(
                "insert into team_membership (id, user_id, team_id, role_id, created_at) values (?, ?, ?, ?, now())",
                UUID.randomUUID(), user, team, UUID.randomUUID()))
                .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void aRoleThatIsInUse_cannotBeDeleted() {
        UUID user = insertUser("r-" + UUID.randomUUID() + "@x.io");
        UUID team = insertTeam("r-" + UUID.randomUUID());
        jdbc.update("insert into team_membership (id, user_id, team_id, role_id, created_at) values (?, ?, ?, ?, now())",
                UUID.randomUUID(), user, team, roleId("DEPLOYER"));
        assertThatThrownBy(() -> jdbc.update("delete from role where name = 'DEPLOYER'"))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThat(jdbc.queryForObject("select count(*) from role where name = 'DEPLOYER'", Integer.class)).isEqualTo(1);
    }
}
```

**`identity-service/src/test/java/io/appfleet/identity/UserRepositoryTest.java`**

```java
package io.appfleet.identity;

import io.appfleet.identity.user.AppUser;
import io.appfleet.identity.user.UserRepository;
import io.appfleet.identity.user.UserStatus;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataIntegrityViolationException;

import java.lang.reflect.Method;
import java.util.Arrays;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class UserRepositoryTest extends IdentityIntegrationTest {

    @Autowired UserRepository users;

    private static String email() { return "u-" + UUID.randomUUID() + "@x.io"; }

    @Test
    void save_thenFindByEmail_roundTrips() {
        String email = email();
        AppUser saved = users.save(new AppUser(email, "Ada", "hash"));
        AppUser found = users.findByEmail(email).orElseThrow();
        assertThat(found.getId()).isEqualTo(saved.getId());
        assertThat(found.getDisplayName()).isEqualTo("Ada");
        assertThat(found.getStatus()).isEqualTo(UserStatus.ACTIVE);
        assertThat(found.getDeactivatedAt()).isNull();
    }

    @Test
    void email_isStoredLowerCase_andLookedUpThroughNormalize() {
        String lower = email();
        users.save(new AppUser("  " + lower.toUpperCase() + " ", "Bob", "hash"));
        assertThat(users.findByEmail(AppUser.normalize(lower.toUpperCase()))).isPresent();
        assertThat(users.existsByEmail(lower)).isTrue();
    }

    @Test
    void sameEmailTwice_isRefusedByTheDatabase() {
        String email = email();
        users.save(new AppUser(email, "One", "hash"));
        assertThatThrownBy(() -> users.save(new AppUser(email, "Two", "hash")))
                .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void deactivate_isPersisted_andRepeatingItChangesNothing() {
        AppUser user = users.save(new AppUser(email(), "Cy", "hash"));
        user.deactivate();
        var first = user.getDeactivatedAt();
        users.save(user);
        AppUser reloaded = users.findById(user.getId()).orElseThrow();
        assertThat(reloaded.getStatus()).isEqualTo(UserStatus.DEACTIVATED);
        assertThat(reloaded.getDeactivatedAt()).isEqualTo(first);
        reloaded.deactivate();
        assertThat(reloaded.getDeactivatedAt()).isEqualTo(first);
    }

    @Test
    void userRepository_hasNoDeleteMethod() {
        assertThat(Arrays.stream(UserRepository.class.getMethods()).map(Method::getName))
                .noneMatch(n -> n.startsWith("delete") || n.startsWith("remove"));
    }
}
```

**`identity-service/src/test/java/io/appfleet/identity/RbacTest.java`**

```java
package io.appfleet.identity;

import io.appfleet.identity.rbac.PermissionResolver;
import io.appfleet.identity.rbac.Role;
import io.appfleet.identity.rbac.RoleRepository;
import io.appfleet.identity.team.Team;
import io.appfleet.identity.team.TeamMembership;
import io.appfleet.identity.team.TeamMembershipRepository;
import io.appfleet.identity.team.TeamRepository;
import io.appfleet.identity.team.TeamRole;
import io.appfleet.identity.user.AppUser;
import io.appfleet.identity.user.UserRepository;
import jakarta.persistence.EntityManagerFactory;
import org.hibernate.SessionFactory;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.access.hierarchicalroles.RoleHierarchy;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class RbacTest extends IdentityIntegrationTest {

    @Autowired PermissionResolver resolver;
    @Autowired RoleHierarchy hierarchy;
    @Autowired RoleRepository roles;
    @Autowired UserRepository users;
    @Autowired TeamRepository teams;
    @Autowired TeamMembershipRepository memberships;
    @Autowired EntityManagerFactory emf;

    @Test
    void viewer_hasOnlyTheReadPermissions() {
        assertThat(resolver.permissionsFor("VIEWER")).containsExactly("application:read", "deployment:read");
    }

    @Test
    void deployer_inheritsViewer() {
        assertThat(resolver.permissionsFor("DEPLOYER")).containsExactly(
                "application:create", "application:read", "deployment:create", "deployment:read");
    }

    @Test
    void operator_inheritsDeployerAndViewer() {
        assertThat(resolver.permissionsFor("OPERATOR")).containsExactly(
                "application:create", "application:read", "deployment:create", "deployment:read",
                "deployment:rollback", "node:drain");
    }

    @Test
    void admin_holdsEveryPermission() {
        Set<String> all = new HashSet<>(jdbc.queryForList("select name from permission", String.class));
        assertThat(resolver.permissionsFor("ADMIN")).isEqualTo(all).hasSize(8);
    }

    @Test
    void unknownRole_isRefused() {
        assertThatThrownBy(() -> resolver.permissionsFor("ROOT"))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("ROOT");
    }

    /** The hierarchy lives in code, the roles in the database; they must name the same four roles. */
    @Test
    void hierarchy_andDatabase_nameTheSameRoles() {
        Set<String> inDb = new HashSet<>(jdbc.queryForList("select name from role", String.class));
        Set<String> fromTop = hierarchy.getReachableGrantedAuthorities(List.of(new SimpleGrantedAuthority("ADMIN")))
                .stream().map(GrantedAuthority::getAuthority).collect(Collectors.toSet());
        assertThat(fromTop).isEqualTo(inDb);
    }

    @Test
    void grants_ofOneUser_comeBackInOneSelect() {
        AppUser user = users.save(new AppUser("g-" + UUID.randomUUID() + "@x.io", "Gus", "hash"));
        Team a = teams.save(new Team("a-" + UUID.randomUUID()));
        Team b = teams.save(new Team("b-" + UUID.randomUUID()));
        Role deployer = roles.findByName("DEPLOYER").orElseThrow();
        Role viewer = roles.findByName("VIEWER").orElseThrow();
        memberships.save(new TeamMembership(user, a, deployer));
        memberships.save(new TeamMembership(user, b, viewer));

        var statistics = emf.unwrap(SessionFactory.class).getStatistics();
        statistics.clear();
        List<TeamRole> grants = memberships.findGrantsByUserId(user.getId());
        assertThat(statistics.getPrepareStatementCount()).as("statements").isEqualTo(1);
        assertThat(grants).containsExactlyInAnyOrder(new TeamRole(a.getId(), "DEPLOYER"), new TeamRole(b.getId(), "VIEWER"));
    }

    @Test
    void aUserWithNoMembership_hasNoGrants() {
        AppUser user = users.save(new AppUser("n-" + UUID.randomUUID() + "@x.io", "Nil", "hash"));
        assertThat(memberships.findGrantsByUserId(user.getId())).isEmpty();
    }
}
```

**`identity-service/src/test/java/io/appfleet/identity/SecurityChainTest.java`**

```java
package io.appfleet.identity;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

import static org.assertj.core.api.Assertions.assertThat;

/** Real HTTP: MockMvc would skip the filter chain. */
class SecurityChainTest extends IdentityIntegrationTest {

    @Value("${local.server.port}") int port;

    private final HttpClient client = HttpClient.newHttpClient();

    private int status(String path) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).GET().build();
        return client.send(request, HttpResponse.BodyHandlers.ofString()).statusCode();
    }

    @Test
    void health_isOpen() throws Exception {
        assertThat(status("/actuator/health")).isEqualTo(200);
    }

    @Test
    void everythingElse_isRefused() throws Exception {
        assertThat(status("/actuator/env")).isEqualTo(403);
        assertThat(status("/api/v1/users/me")).isEqualTo(403);
        assertThat(status("/anything")).isEqualTo(403);
    }
}
```

## 7. Order of work

1. Edit `application.yml` (section 4).
2. Write the six test classes (section 6). They do not compile until step 3 has the classes they use, so write the migration and the entities first if you prefer, but **run the red run (section 8.1) before you trust the green one**.
3. `V2` migration (5.1), then the entities and repositories (5.2 to 5.5), then the chain (5.6).
4. `mvn -f identity-service\pom.xml test -DargLine="-Duser.timezone=UTC"`. Expected: **27 tests, 0 failures**. Docker must be running.
5. Mutation checks (section 8.2) on a scratch copy; restore each file and touch it before the next case.
6. Results section; the plan's I1 row; a concepts-guide lesson; the Outline pages.

## 8. Verification, 2026-10-06 (scratch copy, your real pom and yml)

### 8.1 Red run

With the `V2` migration deleted and a clean build, `SchemaAndSeedTest` fails because the context does not start: `Failed to initialize JPA EntityManagerFactory` (Hibernate's `validate` finds no tables). **Trap found on the way:** the first attempt, without `clean`, passed 3 of 3, because Maven kept the migration already copied into `target/classes`. After deleting or changing a resource, run `clean`.

### 8.2 Mutation checks (each seen red, then restored)

| Mutation | Result |
|---|---|
| Drop `ck_app_user_email_lower` | `ConstraintTest.upperCaseEmail_isRefused_soTwoSpellingsCannotCoexist` fails (1 of 9) |
| Replace the `UNIQUE (user_id, team_id)` constraint with `CHECK (true)` | `ConstraintTest.secondRoleForTheSameUserAndTeam_isRefused` fails (1 of 9) |
| Remove `DEPLOYER > VIEWER` from the hierarchy | 4 of 8 `RbacTest` fail: `admin_holdsEveryPermission`, `deployer_inheritsViewer`, `hierarchy_andDatabase_nameTheSameRoles`, `operator_inheritsDeployerAndViewer` |
| `UserRepository` extends `CrudRepository` | `UserRepositoryTest.userRepository_hasNoDeleteMethod` fails (1 of 5) |
| `anyRequest().permitAll()` in the chain | `SecurityChainTest.everythingElse_isRefused` fails (1 of 2) |

After restoring: 27 tests, 0 failures.

**A mistake of mine, kept as a lesson:** one mutation helper took its backup after each of three edits to the same file, so the backup was the already-mutated file and the restore did nothing; "back to green" then failed on the very test that mutation had broken. Back up once per file, before the first edit, and compare the restored file with the source before trusting a green.

## 9. What this step deliberately does not do

- No endpoint, no token, no password hashing (I2). `password_hash` is just a column here.
- No refresh tokens, API keys or login audit tables (I3, I7, I5).
- No admin API for roles, permissions, teams or members (I6); the tests write rows with SQL and the repositories.
- No cache for the resolver (decision 12).
- No problem-shape error bodies (I2).

## Definition of done

- [x] `application.yml` has `open-in-view: false` and the default schema
- [x] The red run done first: the missing migration makes the context fail
- [x] `V2` migration, entities, repositories, hierarchy, resolver and chain in place
- [x] 27 tests green with `mvn -f identity-service\pom.xml test`
- [x] The five mutation checks seen red on a scratch copy and restored
- [x] The role hierarchy and the database proven to name the same roles
- [x] A user cannot be deleted through `UserRepository` (test)
- [x] Results written; the plan's I1 row updated
- [x] Concepts-guide lessons for I1: `sp-repository-interfaces` (repository interfaces) and `sec-scoped-grants` (scoped grants and the role hierarchy), 2026-10-06; Outline pages: the `identity-service` page with this doc, the plan and I2 (2026-10-06)

## 10. Results (built by hand, 2026-10-06)

- Real tree: `mvn -f identity-service\pom.xml test -DargLine="-Duser.timezone=UTC"`: **27 tests, 0 failures** (`ConstraintTest` 9, `RbacTest` 8, `SchemaAndSeedTest` 3, `SecurityChainTest` 2, `UserRepositoryTest` 5).
- The first run on the real tree had 26 green and 1 error: `RbacTest.grants_ofOneUser_comeBackInOneSelect` failed with `No default constructor for entity 'io.appfleet.identity.team.Team'`. `Team` was missing its `protected Team() {}`. Only that test hit it, because Hibernate creates a `Team` instance only when a lazy association is loaded. After adding the constructor, 27 of 27.
- The red run and the five mutation checks (section 8) were done on the scratch copy; they were not repeated on the real tree.
- `Role` and `Permission` have no public constructors, as designed (decision 11). The seed is the only way a role or permission exists in I1.
- The two concepts-guide lessons and the Outline pages were done the same day (see the checklist).
