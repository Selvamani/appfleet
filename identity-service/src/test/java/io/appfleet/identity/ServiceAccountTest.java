package io.appfleet.identity;

import io.appfleet.identity.team.PlatformTeam;
import io.appfleet.identity.token.TokenHasher;
import io.appfleet.security.AppfleetJwtAuthenticationConverter;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import tools.jackson.databind.JsonNode;

import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/** Service accounts and their API keys over real HTTP: who may manage them, what a key is worth, and what the token looks like. */
class ServiceAccountTest extends AuthHttpTest {

    private static final String EXCHANGE = "/api/v1/auth/service-token";

    @Autowired JwtDecoder decoder;
    @Autowired AppfleetJwtAuthenticationConverter converter;

    record Who(String email, UUID id, String token) {}

    // ------------------------------------------------------------------ helpers

    private UUID idOf(String email) {
        return jdbc.queryForObject("select id from app_user where email = ?", UUID.class, email);
    }

    private UUID newTeam() {
        UUID id = UUID.randomUUID();
        jdbc.update("insert into team (id, name, created_at) values (?, ?, now())", id, "team-" + id);
        return id;
    }

    private Who user(UUID teamId, String role) throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        if (teamId != null)
            jdbc.update("insert into team_membership (id, user_id, team_id, role_id, created_at) values (?, ?, ?, (select id from role where name = ?), now())",
                    UUID.randomUUID(), idOf(email), teamId, role);
        return new Who(email, idOf(email), body(login(email, PASSWORD)).get("accessToken").asString());
    }

    private HttpResponse<String> call(String method, String path, Who who, Object payload) throws Exception {
        return send(method, path, who == null ? null : who.token(), payload == null ? null : json.writeValueAsString(payload));
    }

    private String accountsPath(UUID team) {
        return "/api/v1/teams/" + team + "/service-accounts";
    }

    private static String name() {
        return "svc-" + UUID.randomUUID().toString().substring(0, 8);
    }

    /** Creates an account (VIEWER unless told) and returns the 201 body. */
    private JsonNode create(Who admin, UUID team, String role) throws Exception {
        HttpResponse<String> r = call("POST", accountsPath(team), admin, Map.of("name", name(), "role", role));
        assertThat(r.statusCode()).as(r.body()).isEqualTo(201);
        return body(r);
    }

    private HttpResponse<String> exchange(String key) throws Exception {
        return post(EXCHANGE, Map.of("apiKey", key));
    }

    private Map<String, Object> withoutPerRequestFields(HttpResponse<String> r) {
        Map<String, Object> m = new java.util.LinkedHashMap<>(json.convertValue(body(r), Map.class));
        m.remove("correlationId");
        return m;
    }

    private String secretOf(String key) {
        return key.substring(key.indexOf('.') + 1);
    }

    // ------------------------------------------------------------------ the key: shown once, hashed at rest

    @Test
    void theKey_isShownOnce_andNothingOfItIsStoredButItsHash() throws Exception {
        UUID team = newTeam();
        Who admin = user(team, "ADMIN");
        JsonNode created = create(admin, team, "DEPLOYER");
        String key = created.get("key").get("apiKey").asString();
        UUID keyId = UUID.fromString(created.get("key").get("keyId").asString());

        assertThat(key).startsWith("afk_").hasSize(59);
        assertThat(key).isEqualTo("afk_" + created.get("key").get("prefix").asString() + "." + secretOf(key));

        Map<String, Object> row = jdbc.queryForMap("select * from api_key where id = ?", keyId);
        assertThat(row.get("key_hash")).isEqualTo(TokenHasher.hash(key));
        assertThat(row.toString()).as("a database read finds no part of the secret").doesNotContain(secretOf(key)).doesNotContain(key);

        HttpResponse<String> list = call("GET", accountsPath(team), admin, null);
        assertThat(list.body()).as("a list never repeats the key").doesNotContain(secretOf(key)).doesNotContain("apiKey");
        assertThat(list.body()).contains(created.get("key").get("prefix").asString());
    }

    // ------------------------------------------------------------------ the exchange

    @Test
    void aKey_isExchangedForATokenThatControlApiWouldRead() throws Exception {
        UUID team = newTeam();
        Who admin = user(team, "ADMIN");
        JsonNode created = create(admin, team, "DEPLOYER");
        UUID accountId = UUID.fromString(created.get("account").get("id").asString());

        HttpResponse<String> r = exchange(created.get("key").get("apiKey").asString());
        assertThat(r.statusCode()).isEqualTo(200);
        JsonNode b = body(r);
        assertThat(b.get("tokenType").asString()).isEqualTo("Bearer");
        assertThat(b.get("expiresIn").asLong()).as("the service token life, 5 minutes").isEqualTo(300);
        assertThat(b.has("refreshToken")).as("no refresh token: the service asks again with its key").isFalse();

        Jwt jwt = decoder.decode(b.get("accessToken").asString());       // common-security's own decoder, the one control-api runs
        assertThat(jwt.getSubject()).isEqualTo(accountId.toString());
        assertThat(jwt.getHeaders().get("kid")).as("the service token names its signing key too").isNotNull();
        assertThat(Duration.between(jwt.getIssuedAt(), jwt.getExpiresAt())).isEqualTo(Duration.ofMinutes(5));
        assertThat(jwt.getId()).isNotBlank();
        List<String> authorities = converter.convert(jwt).getAuthorities().stream().map(GrantedAuthority::getAuthority).toList();
        assertThat(authorities).contains("application:create", "deployment:create", "deployment:read").doesNotContain("user:manage", "deployment:rollback");
        Map<?, ?> teams = jwt.getClaim("teams");
        assertThat(teams.keySet().stream().map(Object::toString).toList()).containsExactly(team.toString());
    }

    @Test
    void everyRefusal_isTheSame401_whateverWasWrongWithTheKey() throws Exception {
        UUID team = newTeam();
        Who admin = user(team, "ADMIN");
        JsonNode good = create(admin, team, "VIEWER");
        String key = good.get("key").get("apiKey").asString();
        String prefix = good.get("key").get("prefix").asString();

        JsonNode revokedAccount = create(admin, team, "VIEWER");
        String revokedKey = revokedAccount.get("key").get("apiKey").asString();
        call("DELETE", accountsPath(team) + "/" + revokedAccount.get("account").get("id").asString() + "/keys/" + revokedAccount.get("key").get("keyId").asString(), admin, null);

        JsonNode disabledAccount = create(admin, team, "VIEWER");
        String disabledKey = disabledAccount.get("key").get("apiKey").asString();
        call("POST", accountsPath(team) + "/" + disabledAccount.get("account").get("id").asString() + "/disable", admin, null);

        String wrongSecret = "afk_" + prefix + "." + TokenHasher.newToken();
        String unknownPrefix = ("afk_" + TokenHasher.newToken().substring(0, 11) + "." + TokenHasher.newToken());

        Map<String, Object> reference = withoutPerRequestFields(exchange(wrongSecret));
        for (String bad : List.of(wrongSecret, unknownPrefix, "hello", "afk_short.key", revokedKey, disabledKey)) {
            HttpResponse<String> r = exchange(bad);
            assertThat(r.statusCode()).as(bad).isEqualTo(401);
            assertThat(withoutPerRequestFields(r)).as("the same body for: " + bad).isEqualTo(reference);
        }
        assertThat(exchange(key).statusCode()).as("the good key still works").isEqualTo(200);
        assertThat(post(EXCHANGE, Map.of("apiKey", "   ")).statusCode()).as("a blank body field is a 400").isEqualTo(400);
    }

    @Test
    void everyExchange_isAudited_theCallerNeverSeesWhy() throws Exception {
        UUID team = newTeam();
        Who admin = user(team, "ADMIN");
        JsonNode created = create(admin, team, "VIEWER");
        UUID accountId = UUID.fromString(created.get("account").get("id").asString());
        String key = created.get("key").get("apiKey").asString();

        exchange(key);
        exchange("afk_" + created.get("key").get("prefix").asString() + "." + TokenHasher.newToken());
        exchange("afk_" + TokenHasher.newToken().substring(0, 11) + "." + TokenHasher.newToken());

        List<String> mine = jdbc.queryForList("select outcome from login_audit where event = 'SERVICE_TOKEN' and service_account_id = ? order by id", String.class, accountId);
        assertThat(mine).containsExactly("SUCCESS", "INVALID_KEY");
        assertThat(jdbc.queryForObject("select count(*) from login_audit where event = 'SERVICE_TOKEN' and outcome = 'INVALID_KEY' and service_account_id is null and occurred_at > now() - interval '1 minute'", Integer.class))
                .as("an unknown prefix is audited without an account").isGreaterThanOrEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from login_audit where event = 'SERVICE_TOKEN' and (email is not null or user_id is not null)", Integer.class)).isZero();

        Who platform = user(PlatformTeam.ID, "ADMIN");
        HttpResponse<String> audit = call("GET", "/api/v1/audit/logins?limit=200", platform, null);
        assertThat(audit.body()).contains("SERVICE_TOKEN").contains(accountId.toString()).doesNotContain(secretOf(key));
    }

    @Test
    void lastUsed_isRecordedOnTheKey() throws Exception {
        UUID team = newTeam();
        Who admin = user(team, "ADMIN");
        JsonNode created = create(admin, team, "VIEWER");
        UUID keyId = UUID.fromString(created.get("key").get("keyId").asString());
        assertThat(jdbc.queryForObject("select last_used_at from api_key where id = ?", Object.class, keyId)).isNull();
        assertThat(exchange(created.get("key").get("apiKey").asString()).statusCode()).isEqualTo(200);
        assertThat(jdbc.queryForObject("select last_used_at from api_key where id = ?", Object.class, keyId)).isNotNull();
    }

    // ------------------------------------------------------------------ rotation and disabling

    @Test
    void rotation_addsASecondKey_theOldOneIsRevokedLast_andNeverMoreThanTwoAreActive() throws Exception {
        UUID team = newTeam();
        Who admin = user(team, "ADMIN");
        JsonNode created = create(admin, team, "VIEWER");
        String account = created.get("account").get("id").asString();
        String oldKey = created.get("key").get("apiKey").asString();
        String oldId = created.get("key").get("keyId").asString();

        HttpResponse<String> added = call("POST", accountsPath(team) + "/" + account + "/keys", admin, null);
        assertThat(added.statusCode()).isEqualTo(201);
        String newKey = body(added).get("apiKey").asString();
        assertThat(exchange(oldKey).statusCode()).as("both work during the overlap").isEqualTo(200);
        assertThat(exchange(newKey).statusCode()).isEqualTo(200);
        assertThat(call("POST", accountsPath(team) + "/" + account + "/keys", admin, null).statusCode()).as("a third active key").isEqualTo(409);

        assertThat(call("DELETE", accountsPath(team) + "/" + account + "/keys/" + oldId, admin, null).statusCode()).isEqualTo(204);
        assertThat(exchange(oldKey).statusCode()).as("the old key is dead").isEqualTo(401);
        assertThat(exchange(newKey).statusCode()).as("the new key works").isEqualTo(200);
        assertThat(call("DELETE", accountsPath(team) + "/" + account + "/keys/" + oldId, admin, null).statusCode()).as("revoking twice changes nothing").isEqualTo(204);
        assertThat(call("DELETE", accountsPath(team) + "/" + account + "/keys/" + UUID.randomUUID(), admin, null).statusCode()).isEqualTo(404);
        assertThat(call("POST", accountsPath(team) + "/" + account + "/keys", admin, null).statusCode()).as("room again after a revocation").isEqualTo(201);
    }

    @Test
    void disabling_endsTheAccountForGood() throws Exception {
        UUID team = newTeam();
        Who admin = user(team, "ADMIN");
        JsonNode created = create(admin, team, "VIEWER");
        String account = created.get("account").get("id").asString();
        String key = created.get("key").get("apiKey").asString();

        HttpResponse<String> r = call("POST", accountsPath(team) + "/" + account + "/disable", admin, null);
        assertThat(r.statusCode()).isEqualTo(200);
        assertThat(body(r).get("status").asString()).isEqualTo("DISABLED");
        assertThat(exchange(key).statusCode()).isEqualTo(401);
        assertThat(call("POST", accountsPath(team) + "/" + account + "/keys", admin, null).statusCode()).as("no new key for a disabled account").isEqualTo(409);
        assertThat(call("POST", accountsPath(team) + "/" + account + "/disable", admin, null).statusCode()).as("twice changes nothing").isEqualTo(200);
    }

    // ------------------------------------------------------------------ who may manage them

    @Test
    void onlyAdministratorsOfTheTeam_orThePlatform_manageItsServiceAccounts() throws Exception {
        UUID team = newTeam();
        UUID other = newTeam();
        Who admin = user(team, "ADMIN");
        JsonNode created = create(admin, team, "VIEWER");
        String account = created.get("account").get("id").asString();
        String key = created.get("key").get("keyId").asString();

        Object[][] calls = {
                {"GET", accountsPath(team), null}, {"POST", accountsPath(team), Map.of("name", name(), "role", "VIEWER")},
                {"POST", accountsPath(team) + "/" + account + "/keys", null},
                {"DELETE", accountsPath(team) + "/" + account + "/keys/" + key, null},
                {"POST", accountsPath(team) + "/" + account + "/disable", null}};
        Who plain = user(null, null);
        Who member = user(team, "DEPLOYER");
        Who otherAdmin = user(other, "ADMIN");
        for (Who denied : List.of(plain, member, otherAdmin))
            for (Object[] c : calls)
                assertThat(call((String) c[0], (String) c[1], denied, c[2]).statusCode()).as(denied.email() + " " + c[0] + " " + c[1]).isEqualTo(403);
        assertThat(call("GET", accountsPath(team), null, null).statusCode()).isEqualTo(401);

        Who platform = user(PlatformTeam.ID, "ADMIN");
        assertThat(call("GET", accountsPath(team), platform, null).statusCode()).isEqualTo(200);
        assertThat(call("POST", accountsPath(team), platform, Map.of("name", name(), "role", "VIEWER")).statusCode()).isEqualTo(201);
    }

    @Test
    void anAccountOfAnotherTeam_isNotFound_evenForAnAdministratorOfAnotherTeam() throws Exception {
        UUID teamA = newTeam();
        UUID teamB = newTeam();
        Who adminA = user(teamA, "ADMIN");
        Who adminB = user(teamB, "ADMIN");
        JsonNode created = create(adminA, teamA, "VIEWER");
        String account = created.get("account").get("id").asString();
        String key = created.get("key").get("keyId").asString();
        String keyText = created.get("key").get("apiKey").asString();

        // adminB is a perfectly good administrator, of team B: the path says team B, the account is team A's
        assertThat(call("POST", accountsPath(teamB) + "/" + account + "/keys", adminB, null).statusCode()).isEqualTo(404);
        assertThat(call("DELETE", accountsPath(teamB) + "/" + account + "/keys/" + key, adminB, null).statusCode()).isEqualTo(404);
        assertThat(call("POST", accountsPath(teamB) + "/" + account + "/disable", adminB, null).statusCode()).isEqualTo(404);
        assertThat(call("GET", accountsPath(teamB), adminB, null).body()).doesNotContain(account);
        assertThat(exchange(keyText).statusCode()).as("nothing of team A was touched").isEqualTo(200);
    }

    @Test
    void anUnknownTeam_is404_forThePlatformAdministrator() throws Exception {
        Who platform = user(PlatformTeam.ID, "ADMIN");
        assertThat(call("POST", accountsPath(UUID.randomUUID()), platform, Map.of("name", name(), "role", "VIEWER")).statusCode()).isEqualTo(404);
        assertThat(call("GET", accountsPath(UUID.randomUUID()), platform, null).statusCode()).isEqualTo(404);
    }

    // ------------------------------------------------------------------ what a service account may be

    @Test
    void aServiceAccount_cannotHoldARoleThatManagesUsers_andTheRoleMustExist() throws Exception {
        UUID team = newTeam();
        Who admin = user(team, "ADMIN");
        HttpResponse<String> adminRole = call("POST", accountsPath(team), admin, Map.of("name", name(), "role", "ADMIN"));
        assertThat(adminRole.statusCode()).isEqualTo(400);
        assertThat(body(adminRole).get("errors").toString()).contains("\"field\":\"role\"").contains("manages users");
        HttpResponse<String> unknown = call("POST", accountsPath(team), admin, Map.of("name", name(), "role", "KING"));
        assertThat(unknown.statusCode()).isEqualTo(400);
        assertThat(body(unknown).get("errors").toString()).contains("unknown role");
        assertThat(call("POST", accountsPath(team), admin, Map.of("name", name(), "role", "OPERATOR")).statusCode()).as("OPERATOR does not manage users").isEqualTo(201);
    }

    @Test
    void theName_isASlug_andUniqueWithinTheTeam() throws Exception {
        UUID team = newTeam();
        Who admin = user(team, "ADMIN");
        String n = name();
        assertThat(call("POST", accountsPath(team), admin, Map.of("name", n, "role", "VIEWER")).statusCode()).isEqualTo(201);
        assertThat(call("POST", accountsPath(team), admin, Map.of("name", n, "role", "VIEWER")).statusCode()).isEqualTo(409);
        UUID second = newTeamWith(admin);
        Who again = new Who(admin.email(), admin.id(), body(login(admin.email(), PASSWORD)).get("accessToken").asString());   // a new grant shows in the NEXT token
        assertThat(call("POST", accountsPath(second), again, Map.of("name", n, "role", "VIEWER")).statusCode()).as("the same name in another team is fine").isEqualTo(201);
        for (String bad : List.of("Upper", "has space", "x", "-lead", "under_score"))
            assertThat(call("POST", accountsPath(team), admin, Map.of("name", bad, "role", "VIEWER")).statusCode()).as(bad).isEqualTo(400);
    }

    private UUID newTeamWith(Who admin) {
        UUID team = newTeam();
        jdbc.update("insert into team_membership (id, user_id, team_id, role_id, created_at) values (?, ?, ?, (select id from role where name = 'ADMIN'), now())",
                UUID.randomUUID(), admin.id(), team);
        return team;
    }

    @Test
    void aServiceToken_isNotAUser_andCannotAdministerAnything() throws Exception {
        UUID team = newTeam();
        Who admin = user(team, "ADMIN");
        JsonNode created = create(admin, team, "OPERATOR");
        String token = body(exchange(created.get("key").get("apiKey").asString())).get("accessToken").asString();

        assertThat(send("GET", "/api/v1/users/me", token, null).statusCode()).as("the subject is not a user").isEqualTo(401);
        assertThat(send("GET", "/api/v1/teams/" + team + "/members", token, null).statusCode()).as("OPERATOR does not manage users").isEqualTo(403);
        assertThat(send("GET", accountsPath(team), token, null).statusCode()).isEqualTo(403);
        assertThat(send("GET", "/api/v1/users", token, null).statusCode()).isEqualTo(403);
    }
}