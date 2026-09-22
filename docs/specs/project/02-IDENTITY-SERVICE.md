# identity-service — implementation spec

**[← Build Guide](00-BUILD-GUIDE.md)** · Slice **S4** · Port **8082** · Schema **`identity`**

Authentication and the RBAC model. Issues JWTs everyone else validates locally. **CPU-bound by design** — BCrypt is expensive on purpose, which is the real reason this scales differently from every other service.

> **The boundary rule:** identity owns *who you are and what you may do in general*. control-api owns *whether you may do this to this object*. **Authentication centralises; authorization stays with the data.**

---

## Domain model

```
User ──N:M── Role ──N:M── Permission          deployment:create · deployment:rollback
 │                                             node:drain · catalog:publish · user:manage
 ├──1:N── TeamMembership ──N:1── Team
 │            └── role granted PER TEAM        ✱ scoped grants — the part tutorials skip
 ├──1:N── RefreshToken                         (family id, rotation chain)
 ├──1:N── ApiKey                               (service accounts, scoped, rotatable)
 └──1:N── LoginAudit                           (append-only)
```

- [ ] Roles: `VIEWER < DEPLOYER < OPERATOR < ADMIN` — **`RoleHierarchy`**, so grants don't repeat transitively
- [ ] **Permissions are the atoms; roles are named bundles.** Enforcement checks permissions, never role names — so a new role needs no code change. Be able to say that sentence
- [ ] **Scoped grants:** membership carries the role — *deployer on Team A, viewer on Team B*. Global roles are the degenerate case, not the model
- [ ] Users deactivate, never hard-delete *(audit integrity)*

## Token design

- [ ] **JWT signed RS256** — private key here, public key distributed; **know why RSA and not HMAC for multi-service**
- [ ] Access token **≤ 15 min**: `sub`, `jti`, roles, **team-scoped permissions claim** *(a compact map — keep the token under ~1KB and know why size matters in a header)*
- [ ] **Refresh rotation:** one-time-use, chained by family id. **Reuse of a consumed token = theft signal → revoke the whole family.** Test exactly that
- [ ] JWKS endpoint (`/.well-known/jwks.json`) so services fetch the public key — and key **rotation** with a `kid`, old key honoured until expiry
- [ ] **Revocation:** Redis denylist by `jti`, TTL = remaining life. Then **argue the other side** — short expiry + rotation is usually the better answer, and you built both

## Endpoints

```
POST /api/v1/auth/register · login · refresh · logout
GET  /.well-known/jwks.json
GET/PUT /api/v1/users/me · POST /users/me/password
ADMIN: CRUD /users /roles /teams · POST /teams/{id}/members (role-scoped)
       POST /service-accounts → scoped ApiKey (shown once)
GET  /api/v1/audit/logins?cursor=            (ADMIN)
```

## Security hardening — each one testable

- [ ] BCrypt, cost **12** — measure hash time at 10/12/14 and put the numbers in `/docs` *(this is the CPU-bound evidence for the scaling section)*
- [ ] **Lockout:** N failures in a sliding window *(Redis `INCR` + `EXPIRE`)* → 423 + `Retry-After`. Uniform error message — **no user enumeration**, and same-shaped response timing for unknown users
- [ ] Password policy + breach-list check on registration
- [ ] **LoginAudit on every attempt** — success/failure, IP, UA, correlation id — written `REQUIRES_NEW` so a rolled-back login still leaves its audit row
- [ ] Service accounts authenticate with scoped API keys — hashed at rest, shown once, rotatable — **never a shared secret in config**

## The deliberate bugs *(the point of the module)*

| Build it broken | Then | Keep |
|---|---|---|
| **Stale permissions in a live JWT** — revoke a role, old token still works until expiry | denylist by `jti`; argue denylist vs short-expiry in `/docs` | both tests |
| **Refresh replay** — use a rotated token twice | family revocation fires | the theft-detection test |
| **`@PreAuthorize` on an internal self-invoked method** — silently skipped | extract the collaborator; note it's the same proxy issue as `@Transactional`, **but a security hole** | `@Disabled` test |
| **Method security not enabled** — annotations present, doing nothing | `@EnableMethodSecurity`; a meta-test that asserts a protected endpoint actually 403s | the meta-test |
| **User enumeration** — different error for unknown user vs wrong password | uniform message + timing | the comparison test |

## Definition of done

- [ ] `mvn verify` green — Testcontainers Postgres + Redis
- [ ] `common-security` consumed by control-api: **JWT validated locally, zero network calls to identity on the request path** — prove with a test that stops identity-service and still authorizes
- [ ] BCrypt cost numbers + the denylist-vs-expiry argument in `/docs`
- [ ] Every bug above reproduced, fixed, preserved

> **Unlocks:** draw the filter chain from memory · *"Why is a JWT hard to revoke?"* · *"A user's role is revoked — when does their token stop working?"* · *"How do services authenticate to each other?"* · *"Roles or permissions?"*
