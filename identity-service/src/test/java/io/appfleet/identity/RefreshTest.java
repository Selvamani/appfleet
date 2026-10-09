package io.appfleet.identity;

import io.appfleet.identity.rbac.RoleRepository;
import io.appfleet.identity.team.Team;
import io.appfleet.identity.team.TeamMembership;
import io.appfleet.identity.team.TeamMembershipRepository;
import io.appfleet.identity.team.TeamRepository;
import io.appfleet.identity.token.TokenHasher;
import io.appfleet.identity.user.AppUser;
import io.appfleet.identity.user.UserRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import tools.jackson.databind.JsonNode;

import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.assertj.core.api.Assertions.assertThat;

class RefreshTest extends AuthHttpTest {

    @Autowired JwtDecoder decoder;
    @Autowired UserRepository users;
    @Autowired TeamRepository teams;
    @Autowired TeamMembershipRepository memberships;
    @Autowired RoleRepository roles;

    private JsonNode registerAndLogin(String email) throws Exception {
        register(email, PASSWORD);
        return body(login(email, PASSWORD));
    }

    private String refreshTokenOf(String email) throws Exception {
        return registerAndLogin(email).get("refreshToken").asString();
    }

    private HttpResponse<String> refresh(String token) throws Exception {
        return post("/api/v1/auth/refresh", Map.of("refreshToken", token));
    }

    private Map<String, Object> row(String token) {
        return jdbc.queryForMap("select * from refresh_token where token_hash = ?", TokenHasher.hash(token));
    }

    private UUID familyOf(String token) {
        return (UUID) row(token).get("family_id");
    }

    private int activeInFamily(UUID family) {
        return jdbc.queryForObject("select count(*) from refresh_token where family_id = ? and status = 'ACTIVE'", Integer.class, family);
    }

    private Map<String, Object> withoutPerRequestFields(HttpResponse<String> r) {
        Map<String, Object> m = new LinkedHashMap<>(json.convertValue(body(r), Map.class));
        m.remove("correlationId");
        return m;
    }

    // ---- login --------------------------------------------------------------------------------------------------

    @Test
    void login_returnsARefreshToken_storedOnlyAsItsSha256() throws Exception {
        String token = refreshTokenOf(uniqueEmail());
        assertThat(token).hasSize(43).matches("[A-Za-z0-9_-]+");
        Map<String, Object> row = row(token);
        assertThat(row.get("token_hash")).isEqualTo(TokenHasher.hash(token)).isNotEqualTo(token);
        assertThat((String) row.get("token_hash")).hasSize(64);
        assertThat(row.get("status")).isEqualTo("ACTIVE");
        assertThat(row.get("parent_id")).isNull();
        assertThat(jdbc.queryForObject("select count(*) from refresh_token where token_hash = ?", Integer.class, token))
                .as("the token itself is nowhere in the table").isZero();
    }

    @Test
    void twoLogins_startTwoFamilies() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        String a = body(login(email, PASSWORD)).get("refreshToken").asString();
        String b = body(login(email, PASSWORD)).get("refreshToken").asString();
        assertThat(familyOf(a)).isNotEqualTo(familyOf(b));
    }

    // ---- rotation -----------------------------------------------------------------------------------------------

    @Test
    void refresh_rotates_theOldLinkIsUsed_theNewOneIsItsActiveChild() throws Exception {
        String first = refreshTokenOf(uniqueEmail());
        HttpResponse<String> r = refresh(first);
        assertThat(r.statusCode()).isEqualTo(200);
        assertThat(r.headers().firstValue("Cache-Control").orElse("")).contains("no-store");
        JsonNode b = body(r);
        String second = b.get("refreshToken").asString();
        assertThat(second).hasSize(43).isNotEqualTo(first);
        assertThat(b.get("tokenType").asString()).isEqualTo("Bearer");
        assertThat(b.get("expiresIn").asLong()).isEqualTo(900);

        Map<String, Object> old = row(first);
        Map<String, Object> child = row(second);
        assertThat(old.get("status")).isEqualTo("USED");
        assertThat(old.get("used_at")).isNotNull();
        assertThat(child.get("status")).isEqualTo("ACTIVE");
        assertThat(child.get("family_id")).isEqualTo(old.get("family_id"));
        assertThat(child.get("parent_id")).isEqualTo(old.get("id"));
        assertThat(activeInFamily(familyOf(first))).isEqualTo(1);
    }

    @Test
    void refresh_givesANewAccessTokenWithItsOwnJti() throws Exception {
        String email = uniqueEmail();
        JsonNode first = registerAndLogin(email);
        JsonNode second = body(refresh(first.get("refreshToken").asString()));
        Jwt a = decoder.decode(first.get("accessToken").asString());
        Jwt b = decoder.decode(second.get("accessToken").asString());
        assertThat(b.getSubject()).isEqualTo(a.getSubject());
        assertThat(b.getId()).isNotEqualTo(a.getId());
    }

    @Test
    void refresh_readsTheGrantsAgain_soARoleGrantedSinceLoginShowsUp() throws Exception {
        String email = uniqueEmail();
        String refreshToken = refreshTokenOf(email);
        Team team = teams.save(new Team("r-" + UUID.randomUUID()));
        AppUser user = users.findByEmail(email).orElseThrow();
        memberships.save(new TeamMembership(user, team, roles.findByName("DEPLOYER").orElseThrow()));

        Jwt refreshed = decoder.decode(body(refresh(refreshToken)).get("accessToken").asString());
        Map<String, List<String>> claim = refreshed.getClaim("teams");
        assertThat(claim).containsOnlyKeys(team.getId().toString());
        assertThat(claim.get(team.getId().toString())).contains("deployment:create");
    }

    @Test
    void aChainOfRotations_staysOneFamilyWithOneActiveLink() throws Exception {
        String t1 = refreshTokenOf(uniqueEmail());
        String t2 = body(refresh(t1)).get("refreshToken").asString();
        String t3 = body(refresh(t2)).get("refreshToken").asString();
        assertThat(familyOf(t3)).isEqualTo(familyOf(t1));
        assertThat(activeInFamily(familyOf(t1))).isEqualTo(1);
        assertThat(row(t3).get("parent_id")).isEqualTo(row(t2).get("id"));
    }

    // ---- theft detection ----------------------------------------------------------------------------------------

    /** The theft-detection test. Against a refresh that does not consume the token, the second call returns 200. */
    @Test
    void replayOfAUsedToken_is401_andRevokesTheWholeFamily() throws Exception {
        String first = refreshTokenOf(uniqueEmail());
        String second = body(refresh(first)).get("refreshToken").asString();

        HttpResponse<String> replay = refresh(first);
        assertThat(replay.statusCode()).isEqualTo(401);

        assertThat(activeInFamily(familyOf(first))).as("no link of the family may stay usable").isZero();
        assertThat(row(second).get("status")).isEqualTo("REVOKED");
        assertThat(row(second).get("revoked_at")).isNotNull();
        assertThat(refresh(second).statusCode()).as("the thief's and the owner's newest token are both dead").isEqualTo(401);
    }

    @Test
    void replayOfAnOlderLink_revokesTheFamilyThroughTheLatestOne() throws Exception {
        String t1 = refreshTokenOf(uniqueEmail());
        String t2 = body(refresh(t1)).get("refreshToken").asString();
        String t3 = body(refresh(t2)).get("refreshToken").asString();

        assertThat(refresh(t1).statusCode()).isEqualTo(401);
        assertThat(row(t3).get("status")).isEqualTo("REVOKED");
        assertThat(row(t1).get("status")).as("consumed links keep their history").isEqualTo("USED");
        assertThat(row(t2).get("status")).isEqualTo("USED");
    }

    @Test
    void aReplayInOneFamily_doesNotTouchAnotherFamilyOfTheSameUser() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        String deviceA = body(login(email, PASSWORD)).get("refreshToken").asString();
        String deviceB = body(login(email, PASSWORD)).get("refreshToken").asString();
        refresh(deviceA);
        assertThat(refresh(deviceA).statusCode()).isEqualTo(401);
        assertThat(refresh(deviceB).statusCode()).as("device B is a different family").isEqualTo(200);
    }

    @Test
    void presentingAnAlreadyRevokedToken_isRefused() throws Exception {
        String first = refreshTokenOf(uniqueEmail());
        String second = body(refresh(first)).get("refreshToken").asString();
        refresh(first);                                           // reuse: the family is revoked
        assertThat(refresh(second).statusCode()).isEqualTo(401);  // REVOKED
        assertThat(row(second).get("status")).isEqualTo("REVOKED");
    }

    // ---- other refusals -----------------------------------------------------------------------------------------

    @Test
    void unknownReplayedExpiredAndRevokedTokens_areOneIndistinguishableAnswer() throws Exception {
        String used = refreshTokenOf(uniqueEmail());
        String live = body(refresh(used)).get("refreshToken").asString();
        String expired = refreshTokenOf(uniqueEmail());
        jdbc.update("update refresh_token set expires_at = now() - interval '1 minute' where token_hash = ?", TokenHasher.hash(expired));

        Map<String, Object> unknown = withoutPerRequestFields(refresh(TokenHasher.newToken()));
        Map<String, Object> replayed = withoutPerRequestFields(refresh(used));      // also revokes the family
        Map<String, Object> revoked = withoutPerRequestFields(refresh(live));
        Map<String, Object> expiredBody = withoutPerRequestFields(refresh(expired));

        assertThat(unknown).containsEntry("status", 401).containsEntry("type", "urn:appfleet:problem:unauthorized");
        assertThat(replayed).isEqualTo(unknown);
        assertThat(revoked).isEqualTo(unknown);
        assertThat(expiredBody).isEqualTo(unknown);
    }

    @Test
    void anExpiredToken_isRefused_andIsNotConsumed() throws Exception {
        String token = refreshTokenOf(uniqueEmail());
        jdbc.update("update refresh_token set expires_at = now() - interval '1 minute' where token_hash = ?", TokenHasher.hash(token));
        assertThat(refresh(token).statusCode()).isEqualTo(401);
        assertThat(row(token).get("status")).isEqualTo("ACTIVE");
    }

    @Test
    void aDeactivatedUser_cannotRefresh_andTheFamilyIsRevoked() throws Exception {
        String email = uniqueEmail();
        String token = refreshTokenOf(email);
        jdbc.update("update app_user set status = 'DEACTIVATED', deactivated_at = now() where email = ?", email);
        assertThat(refresh(token).statusCode()).isEqualTo(401);
        assertThat(activeInFamily(familyOf(token))).isZero();
        assertThat(row(token).get("status")).isEqualTo("REVOKED");
    }

    @Test
    void theFamilyHasAnAbsoluteLifetime_thatRotationCannotExtend() throws Exception {
        String token = refreshTokenOf(uniqueEmail());
        UUID family = familyOf(token);
        jdbc.update("update refresh_token set family_started_at = now() - interval '29 days' where family_id = ?", family);

        String child = body(refresh(token)).get("refreshToken").asString();
        // 30 days from the start of the family, so about 1 day from now, and not the 7 days a fresh token would get
        Double hoursLeft = jdbc.queryForObject("select extract(epoch from (expires_at - now())) / 3600 from refresh_token where token_hash = ?",
                Double.class, TokenHasher.hash(child));
        assertThat(hoursLeft).isBetween(22.0, 25.0);
    }

    @Test
    void aFreshFamily_getsTheNormalSevenDays() throws Exception {
        String token = refreshTokenOf(uniqueEmail());
        Double daysLeft = jdbc.queryForObject("select extract(epoch from (expires_at - now())) / 86400 from refresh_token where token_hash = ?",
                Double.class, TokenHasher.hash(token));
        assertThat(daysLeft).isBetween(6.9, 7.1);
    }

    // ---- concurrency --------------------------------------------------------------------------------------------

    /** Two requests with one token are decided one after the other (the row lock): exactly one wins, and the family dies. */
    @Test
    void theSameTokenUsedAtTheSameTime_hasExactlyOneWinner() throws Exception {
        String token = refreshTokenOf(uniqueEmail());
        int threads = 6;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<Integer>> results = new ArrayList<>();
        for (int i = 0; i < threads; i++) {
            results.add(pool.submit(() -> {
                go.await();
                return refresh(token).statusCode();
            }));
        }
        go.countDown();
        List<Integer> statuses = new ArrayList<>();
        for (Future<Integer> f : results) statuses.add(f.get());
        pool.shutdown();

        assertThat(statuses.stream().filter(s -> s == 200).count()).as("winners: " + statuses).isEqualTo(1);
        assertThat(statuses.stream().filter(s -> s == 401).count()).as("losers: " + statuses).isEqualTo(threads - 1);
        assertThat(activeInFamily(familyOf(token))).as("the losers saw a used token and revoked the family").isZero();
    }

    // ---- validation ---------------------------------------------------------------------------------------------

    @Test
    void aBlankMissingOrHugeToken_is400() throws Exception {
        assertThat(refresh("").statusCode()).isEqualTo(400);
        assertThat(post("/api/v1/auth/refresh", Map.of()).statusCode()).isEqualTo(400);
        assertThat(refresh("x".repeat(201)).statusCode()).isEqualTo(400);
    }

    @Test
    void get_onRefresh_isRefused() throws Exception {
        assertThat(get("/api/v1/auth/refresh").statusCode()).isEqualTo(401);
    }
}