package io.appfleet.identity;

import io.appfleet.identity.admin.PlatformAdmins;
import io.appfleet.identity.team.PlatformTeam;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import tools.jackson.databind.JsonNode;

import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/** The admin endpoints over real HTTP: who may call them, what they change, and when the tokens of the people they change stop working. */
class AdminApiTest extends AuthHttpTest {

    private static final String USERS = "/api/v1/users";
    private static final String TEAMS = "/api/v1/teams";
    private static final String ROLES = "/api/v1/roles";
    private static final String AUDIT = "/api/v1/audit/logins";

    @Autowired PlatformAdmins platformAdmins;

    /** A registered, signed-in user. */
    record Who(String email, UUID id, String token) {}

    // ------------------------------------------------------------------ helpers

    private UUID idOf(String email) {
        return jdbc.queryForObject("select id from app_user where email = ?", UUID.class, email);
    }

    private void grant(String email, UUID teamId, String role) {
        jdbc.update("insert into team_membership (id, user_id, team_id, role_id, created_at) values (?, ?, ?, (select id from role where name = ?), now())",
                UUID.randomUUID(), idOf(email), teamId, role);
    }

    private UUID newTeam() {
        UUID id = UUID.randomUUID();
        jdbc.update("insert into team (id, name, created_at) values (?, ?, now())", id, "team-" + id);
        return id;
    }

    private Who signIn(String email) throws Exception {
        return new Who(email, idOf(email), body(login(email, PASSWORD)).get("accessToken").asString());
    }

    /** Registers, optionally grants a role in a team, then signs in (the token is issued after the grant, so it carries it). */
    private Who user(UUID teamId, String role) throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        if (teamId != null) grant(email, teamId, role);
        return signIn(email);
    }

    private Who plain() throws Exception { return user(null, null); }

    private Who platformAdmin() throws Exception { return user(PlatformTeam.ID, "ADMIN"); }

    private HttpResponse<String> call(String method, String path, Who who, Object body) throws Exception {
        return send(method, path, who == null ? null : who.token(), body == null ? null : json.writeValueAsString(body));
    }

    private JsonNode claims(String jwt) {
        return json.readTree(new String(Base64.getUrlDecoder().decode(jwt.split("\\.")[1]), StandardCharsets.UTF_8));
    }

    private List<String> permissionsIn(String jwt, UUID teamId) {
        List<String> out = new ArrayList<>();
        JsonNode teams = claims(jwt).get("teams");          // absent, not empty, when the user has no grants
        JsonNode node = teams == null ? null : teams.get(teamId.toString());
        if (node != null) node.forEach(n -> out.add(n.asString()));
        return out;
    }

    private String errors(HttpResponse<String> r) {
        return body(r).get("errors").toString();
    }

    // ------------------------------------------------------------------ who may call what

    @Test
    void thePlatformTeam_isSeeded_withTheIdTheCodeKnows() {
        assertThat(jdbc.queryForObject("select name from team where id = ?", String.class, PlatformTeam.ID)).isEqualTo("platform");
    }

    @Test
    void aSignedInUserWithNoAdminRole_isRefusedOnEveryAdminEndpoint_with403() throws Exception {
        Who nobody = plain();
        UUID team = newTeam();
        UUID other = UUID.randomUUID();
        Object[][] calls = {
                {"GET", USERS, null}, {"GET", USERS + "/" + other, null}, {"POST", USERS + "/" + other + "/deactivate", null},
                {"GET", TEAMS, null}, {"POST", TEAMS, Map.of("name", "nope-" + other)},
                {"GET", TEAMS + "/" + team + "/members", null},
                {"POST", TEAMS + "/" + team + "/members", Map.of("userId", other, "role", "VIEWER")},
                {"PUT", TEAMS + "/" + team + "/members/" + other, Map.of("role", "VIEWER")},
                {"DELETE", TEAMS + "/" + team + "/members/" + other, null},
                {"GET", ROLES, null}, {"POST", ROLES, Map.of("name", "NOPE", "description", "x", "permissions", List.of("application:read"))},
                {"GET", AUDIT, null}};
        for (Object[] c : calls)
            assertThat(call((String) c[0], (String) c[1], nobody, c[2]).statusCode()).as(c[0] + " " + c[1]).isEqualTo(403);
    }

    @Test
    void anAdminOfOneTeam_isNotAPlatformAdmin_andNotAnAdminOfAnotherTeam() throws Exception {
        UUID mine = newTeam();
        UUID theirs = newTeam();
        Who teamAdmin = user(mine, "ADMIN");
        assertThat(call("GET", USERS, teamAdmin, null).statusCode()).isEqualTo(403);
        assertThat(call("GET", AUDIT, teamAdmin, null).statusCode()).isEqualTo(403);
        assertThat(call("GET", ROLES, teamAdmin, null).statusCode()).isEqualTo(403);
        assertThat(call("GET", TEAMS, teamAdmin, null).statusCode()).isEqualTo(403);
        assertThat(call("POST", TEAMS, teamAdmin, Map.of("name", "x-" + mine)).statusCode()).isEqualTo(403);
        assertThat(call("GET", TEAMS + "/" + mine + "/members", teamAdmin, null).statusCode()).as("own team").isEqualTo(200);
        assertThat(call("GET", TEAMS + "/" + theirs + "/members", teamAdmin, null).statusCode()).as("another team").isEqualTo(403);
    }

    @Test
    void aPlatformAdmin_mayManageTheMembersOfAnyTeam() throws Exception {
        UUID team = newTeam();
        assertThat(call("GET", TEAMS + "/" + team + "/members", platformAdmin(), null).statusCode()).isEqualTo(200);
    }

    @Test
    void withoutAToken_everyAdminEndpoint_is401() throws Exception {
        assertThat(call("GET", USERS, null, null).statusCode()).isEqualTo(401);
        assertThat(call("GET", AUDIT, null, null).statusCode()).isEqualTo(401);
    }

    // ------------------------------------------------------------------ users

    @Test
    void theUserList_isPagedByKeyset_withoutHashesOrDuplicates() throws Exception {
        Who admin = platformAdmin();
        List<UUID> created = new ArrayList<>();
        for (int i = 0; i < 5; i++) created.add(plain().id());

        JsonNode one = body(call("GET", USERS + "?limit=1", admin, null));
        assertThat(one.get("items").size()).isEqualTo(1);
        assertThat(one.get("nextCursor").isNull()).isFalse();

        List<String> seen = new ArrayList<>();
        String cursor = null;
        int pages = 0;
        do {
            HttpResponse<String> r = call("GET", USERS + "?limit=200" + (cursor == null ? "" : "&cursor=" + cursor), admin, null);
            assertThat(r.body()).doesNotContain("password").doesNotContain("$2");
            JsonNode b = body(r);
            b.get("items").forEach(i -> seen.add(i.get("id").asString()));
            cursor = b.get("nextCursor").isNull() ? null : b.get("nextCursor").asString();
        } while (cursor != null && ++pages < 1000);

        assertThat(seen).doesNotHaveDuplicates().isSorted();
        assertThat(seen).containsAll(created.stream().map(UUID::toString).toList());
    }

    @Test
    void aCursorThatIsNotAUuid_is400_notAnInternalError() throws Exception {
        HttpResponse<String> r = call("GET", USERS + "?cursor=not-a-uuid", platformAdmin(), null);
        assertThat(r.statusCode()).isEqualTo(400);
        assertThat(errors(r)).contains("\"field\":\"cursor\"");
    }

    @Test
    void getOneUser_is200_andAnUnknownOne_is404() throws Exception {
        Who admin = platformAdmin();
        Who target = plain();
        HttpResponse<String> r = call("GET", USERS + "/" + target.id(), admin, null);
        assertThat(r.statusCode()).isEqualTo(200);
        assertThat(body(r).get("email").asString()).isEqualTo(target.email());
        HttpResponse<String> missing = call("GET", USERS + "/" + UUID.randomUUID(), admin, null);
        assertThat(missing.statusCode()).isEqualTo(404);
        assertThat(body(missing).get("type").asString()).isEqualTo("urn:appfleet:problem:not-found");
    }

    @Test
    void deactivating_endsEverySessionOfTheUser_atOnce() throws Exception {
        Who admin = platformAdmin();
        String email = uniqueEmail();
        register(email, PASSWORD);
        JsonNode session = body(login(email, PASSWORD));
        String access = session.get("accessToken").asString();
        String refresh = session.get("refreshToken").asString();
        UUID id = idOf(email);
        String active = "select count(*) from refresh_token where user_id = ? and status = 'ACTIVE'";
        assertThat(jdbc.queryForObject(active, Integer.class, id)).as("one live session before").isEqualTo(1);

        HttpResponse<String> r = call("POST", USERS + "/" + id + "/deactivate", admin, null);
        assertThat(r.statusCode()).isEqualTo(200);
        assertThat(body(r).get("status").asString()).isEqualTo("DEACTIVATED");
        // the 401s below would come from the user's status alone; the rows say the sessions were really revoked
        assertThat(jdbc.queryForObject(active, Integer.class, id)).as("no live session after").isZero();

        assertThat(send("GET", USERS + "/me", access, null).statusCode()).as("the live access token").isEqualTo(401);
        assertThat(post("/api/v1/auth/refresh", Map.of("refreshToken", refresh)).statusCode()).as("the refresh token").isEqualTo(401);
        assertThat(login(email, PASSWORD).statusCode()).as("a new sign-in").isEqualTo(401);
        assertThat(call("POST", USERS + "/" + id + "/deactivate", admin, null).statusCode()).as("twice changes nothing").isEqualTo(200);
    }

    @Test
    void anAdmin_cannotDeactivateThemselves_andAnUnknownUser_is404() throws Exception {
        Who admin = platformAdmin();
        assertThat(call("POST", USERS + "/" + admin.id() + "/deactivate", admin, null).statusCode()).isEqualTo(409);
        assertThat(call("POST", USERS + "/" + UUID.randomUUID() + "/deactivate", admin, null).statusCode()).isEqualTo(404);
    }

    // ------------------------------------------------------------------ teams and members

    @Test
    void createTeam_is201_aDuplicateIs409_aShortNameIs400() throws Exception {
        Who admin = platformAdmin();
        String name = "team-" + UUID.randomUUID();
        HttpResponse<String> created = call("POST", TEAMS, admin, Map.of("name", "  " + name + "  "));
        assertThat(created.statusCode()).isEqualTo(201);
        assertThat(body(created).get("name").asString()).isEqualTo(name);
        assertThat(call("POST", TEAMS, admin, Map.of("name", name)).statusCode()).isEqualTo(409);
        assertThat(call("POST", TEAMS, admin, Map.of("name", "x")).statusCode()).isEqualTo(400);
        assertThat(call("GET", TEAMS, admin, null).body()).contains(name);
    }

    @Test
    void aTeamAdmin_addsAndListsMembers_ofTheirOwnTeam() throws Exception {
        UUID team = newTeam();
        Who teamAdmin = user(team, "ADMIN");
        Who member = plain();
        HttpResponse<String> added = call("POST", TEAMS + "/" + team + "/members", teamAdmin, Map.of("userId", member.id(), "role", "VIEWER"));
        assertThat(added.statusCode()).isEqualTo(201);
        assertThat(body(added).get("role").asString()).isEqualTo("VIEWER");

        JsonNode list = body(call("GET", TEAMS + "/" + team + "/members", teamAdmin, null));
        assertThat(list.size()).isEqualTo(2);
        assertThat(list.toString()).contains(member.email()).contains(teamAdmin.email());
        assertThat(permissionsIn(signIn(member.email()).token(), team)).contains("application:read", "deployment:read").doesNotContain("deployment:create");
    }

    @Test
    void addingAMember_refusesDuplicates_unknowns_aBadRole_andADeactivatedUser() throws Exception {
        UUID team = newTeam();
        Who admin = user(team, "ADMIN");
        Who member = plain();
        String path = TEAMS + "/" + team + "/members";
        assertThat(call("POST", path, admin, Map.of("userId", member.id(), "role", "VIEWER")).statusCode()).isEqualTo(201);
        assertThat(call("POST", path, admin, Map.of("userId", member.id(), "role", "VIEWER")).statusCode()).as("duplicate").isEqualTo(409);
        assertThat(call("POST", path, admin, Map.of("userId", UUID.randomUUID(), "role", "VIEWER")).statusCode()).as("unknown user").isEqualTo(404);
        assertThat(call("POST", TEAMS + "/" + UUID.randomUUID() + "/members", platformAdmin(), Map.of("userId", member.id(), "role", "VIEWER")).statusCode()).as("unknown team").isEqualTo(404);

        HttpResponse<String> badRole = call("POST", path, admin, Map.of("userId", plain().id(), "role", "KING"));
        assertThat(badRole.statusCode()).isEqualTo(400);
        assertThat(errors(badRole)).contains("\"field\":\"role\"").contains("unknown role");

        Who gone = plain();
        jdbc.update("update app_user set status = 'DEACTIVATED', deactivated_at = now() where id = ?", gone.id());
        assertThat(call("POST", path, admin, Map.of("userId", gone.id(), "role", "VIEWER")).statusCode()).as("deactivated user").isEqualTo(409);
    }

    @Test
    void aUserInTenTeams_cannotJoinAnEleventh_with422() throws Exception {
        Who admin = platformAdmin();
        Who member = plain();
        for (int i = 0; i < 10; i++) grant(member.email(), newTeam(), "VIEWER");
        HttpResponse<String> r = call("POST", TEAMS + "/" + newTeam() + "/members", admin, Map.of("userId", member.id(), "role", "VIEWER"));
        assertThat(r.statusCode()).isEqualTo(422);
        assertThat(body(r).get("type").asString()).isEqualTo("urn:appfleet:problem:team-limit");
    }

    @Test
    void changingARole_endsTheSessionsOfThatUser_andTheNextTokenCarriesTheNewRole() throws Exception {
        UUID team = newTeam();
        Who admin = user(team, "ADMIN");
        Who member = user(team, "VIEWER");
        assertThat(permissionsIn(member.token(), team)).doesNotContain("deployment:create");
        assertThat(send("GET", USERS + "/me", member.token(), null).statusCode()).isEqualTo(200);

        HttpResponse<String> r = call("PUT", TEAMS + "/" + team + "/members/" + member.id(), admin, Map.of("role", "DEPLOYER"));
        assertThat(r.statusCode()).isEqualTo(200);
        assertThat(body(r).get("role").asString()).isEqualTo("DEPLOYER");

        assertThat(send("GET", USERS + "/me", member.token(), null).statusCode()).as("the old token stops working").isEqualTo(401);
        assertThat(permissionsIn(signIn(member.email()).token(), team)).contains("deployment:create");
    }

    @Test
    void removingAMember_endsTheirSessions_andTheyLeaveTheList() throws Exception {
        UUID team = newTeam();
        Who admin = user(team, "ADMIN");
        Who member = user(team, "VIEWER");
        assertThat(call("DELETE", TEAMS + "/" + team + "/members/" + member.id(), admin, null).statusCode()).isEqualTo(204);
        assertThat(send("GET", USERS + "/me", member.token(), null).statusCode()).isEqualTo(401);
        assertThat(call("GET", TEAMS + "/" + team + "/members", admin, null).body()).doesNotContain(member.email());
        assertThat(call("DELETE", TEAMS + "/" + team + "/members/" + member.id(), admin, null).statusCode()).as("already gone").isEqualTo(404);
        assertThat(permissionsIn(signIn(member.email()).token(), team)).isEmpty();
    }

    @Test
    void aTeam_alwaysKeepsOneAdmin() throws Exception {
        UUID team = newTeam();
        Who first = user(team, "ADMIN");
        String own = TEAMS + "/" + team + "/members/" + first.id();
        assertThat(call("PUT", own, first, Map.of("role", "VIEWER")).statusCode()).as("demote the only ADMIN").isEqualTo(409);
        assertThat(call("DELETE", own, first, null).statusCode()).as("remove the only ADMIN").isEqualTo(409);

        Who second = plain();
        assertThat(call("POST", TEAMS + "/" + team + "/members", first, Map.of("userId", second.id(), "role", "ADMIN")).statusCode()).isEqualTo(201);
        assertThat(call("PUT", own, first, Map.of("role", "VIEWER")).statusCode()).as("with a second ADMIN it is allowed").isEqualTo(200);
        Who secondAgain = signIn(second.email());
        assertThat(call("DELETE", TEAMS + "/" + team + "/members/" + second.id(), secondAgain, null).statusCode()).as("now the last one").isEqualTo(409);
    }

    // ------------------------------------------------------------------ roles

    @Test
    void theRoleList_showsEachRolesOwnPermissions_notTheInheritedOnes() throws Exception {
        JsonNode roles = body(call("GET", ROLES, platformAdmin(), null));
        Map<String, List<String>> byName = new java.util.HashMap<>();
        roles.forEach(r -> {
            List<String> p = new ArrayList<>();
            r.get("permissions").forEach(x -> p.add(x.asString()));
            byName.put(r.get("name").asString(), p);
        });
        assertThat(byName).containsKeys("VIEWER", "DEPLOYER", "OPERATOR", "ADMIN");
        assertThat(byName.get("ADMIN")).containsExactlyInAnyOrder("catalog:publish", "user:manage");
        assertThat(byName.get("VIEWER")).containsExactlyInAnyOrder("application:read", "deployment:read");
    }

    @Test
    void aNewRole_isARow_andGrantsExactlyItsPermissions() throws Exception {
        Who admin = platformAdmin();
        String name = "AUDITOR_" + Long.toString(System.nanoTime(), 36).toUpperCase();
        HttpResponse<String> created = call("POST", ROLES, admin, Map.of("name", name, "description", " reads and rolls back ",
                "permissions", List.of("deployment:read", "deployment:rollback")));
        try {
            assertThat(created.statusCode()).isEqualTo(201);
            assertThat(body(created).get("description").asString()).isEqualTo("reads and rolls back");

            UUID team = newTeam();
            Who teamAdmin = user(team, "ADMIN");
            Who member = plain();
            assertThat(call("POST", TEAMS + "/" + team + "/members", teamAdmin, Map.of("userId", member.id(), "role", name)).statusCode()).isEqualTo(201);
            assertThat(permissionsIn(signIn(member.email()).token(), team)).containsExactlyInAnyOrder("deployment:read", "deployment:rollback");

            assertThat(call("POST", ROLES, admin, Map.of("name", name, "description", "again", "permissions", List.of("deployment:read"))).statusCode()).as("duplicate").isEqualTo(409);
        } finally {
            // the database is shared by the whole suite, and other tests count exactly four roles
            jdbc.update("delete from team_membership where role_id in (select id from role where name = ?)", name);
            jdbc.update("delete from role_permission where role_id in (select id from role where name = ?)", name);
            jdbc.update("delete from role where name = ?", name);
        }
    }

    @Test
    void aNewRole_refusesAnUnknownPermission_aBadName_andNoPermissions() throws Exception {
        Who admin = platformAdmin();
        HttpResponse<String> unknown = call("POST", ROLES, admin, Map.of("name", "GHOST", "description", "x", "permissions", List.of("moon:walk")));
        assertThat(unknown.statusCode()).isEqualTo(400);
        assertThat(errors(unknown)).contains("\"field\":\"permissions\"").contains("moon:walk");
        assertThat(call("POST", ROLES, admin, Map.of("name", "lower", "description", "x", "permissions", List.of("application:read"))).statusCode()).isEqualTo(400);
        assertThat(call("POST", ROLES, admin, Map.of("name", "EMPTY", "description", "x", "permissions", List.of())).statusCode()).isEqualTo(400);
    }

    // ------------------------------------------------------------------ audit

    @Test
    void theLoginAudit_isReadNewestFirst_andPaged() throws Exception {
        Who admin = platformAdmin();
        String email = uniqueEmail();
        register(email, PASSWORD);
        login(email, "not the password at all");
        login(email, PASSWORD);

        JsonNode page = body(call("GET", AUDIT + "?limit=200", admin, null));
        List<String> ids = new ArrayList<>();
        page.get("items").forEach(i -> ids.add(i.get("id").asString()));
        assertThat(ids).isSortedAccordingTo(Comparator.reverseOrder());
        List<String> mine = new ArrayList<>();
        page.get("items").forEach(i -> { if (email.equals(i.get("email").asString())) mine.add(i.get("outcome").asString()); });
        assertThat(mine).containsExactly("SUCCESS", "BAD_CREDENTIALS");     // newest first

        JsonNode first = body(call("GET", AUDIT + "?limit=1", admin, null));
        assertThat(first.get("items").size()).isEqualTo(1);
        String cursor = first.get("nextCursor").asString();
        JsonNode second = body(call("GET", AUDIT + "?limit=1&cursor=" + cursor, admin, null));
        assertThat(second.get("items").get(0).get("id").asString()).isLessThan(cursor);
    }

    // ------------------------------------------------------------------ the way in, and the handler's manners

    @Test
    void bootstrap_makesARegisteredUserAPlatformAdmin_once() throws Exception {
        Who user = plain();
        assertThat(permissionsIn(user.token(), PlatformTeam.ID)).isEmpty();
        assertThat(platformAdmins.promote(user.email().toUpperCase())).isTrue();
        assertThat(platformAdmins.promote(user.email())).as("second time: nothing to do").isFalse();
        assertThat(platformAdmins.promote("nobody-" + UUID.randomUUID() + "@example.io")).as("unknown user").isFalse();
        assertThat(permissionsIn(signIn(user.email()).token(), PlatformTeam.ID)).contains("user:manage");
        assertThat(call("GET", USERS, signIn(user.email()), null).statusCode()).isEqualTo(200);
    }

    @Test
    void aSignedInCaller_gets404And405Problems_notA500() throws Exception {
        Who user = plain();
        HttpResponse<String> unknown = call("GET", "/api/v1/nothing-here", user, null);
        assertThat(unknown.statusCode()).isEqualTo(404);
        assertThat(body(unknown).get("type").asString()).isEqualTo("urn:appfleet:problem:not-found");
        HttpResponse<String> wrongMethod = call("DELETE", USERS + "/me", user, null);
        assertThat(wrongMethod.statusCode()).isEqualTo(405);
        assertThat(body(wrongMethod).get("type").asString()).isEqualTo("urn:appfleet:problem:method-not-allowed");
    }
}