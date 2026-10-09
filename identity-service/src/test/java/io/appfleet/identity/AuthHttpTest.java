package io.appfleet.identity;

import org.springframework.beans.factory.annotation.Value;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Map;
import java.util.UUID;

/** Real HTTP helpers for the auth endpoints (MockMvc would skip the security chain). */
public abstract class AuthHttpTest extends IdentityIntegrationTest {

    protected static final String PASSWORD = "correct horse battery";

    @Value("${local.server.port}")
    protected int port;

    protected final HttpClient client = HttpClient.newHttpClient();
    protected final JsonMapper json = new JsonMapper();

    protected HttpResponse<String> postRaw(String path, String body) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body)).build();
        return client.send(request, HttpResponse.BodyHandlers.ofString());
    }

    protected HttpResponse<String> post(String path, Map<String, ?> body) throws Exception {
        return postRaw(path, json.writeValueAsString(body));
    }

    protected HttpResponse<String> get(String path) throws Exception {
        return client.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).GET().build(),
                HttpResponse.BodyHandlers.ofString());
    }

    protected JsonNode body(HttpResponse<String> response) {
        return json.readTree(response.body());
    }

    protected static String uniqueEmail() {
        return "u-" + UUID.randomUUID() + "@example.io";
    }

    protected HttpResponse<String> register(String email, String password) throws Exception {
        return post("/api/v1/auth/register", Map.of("email", email, "displayName", "Test User", "password", password));
    }

    /** A login with extra request headers (pairs of name and value), for the tests that look at what the audit records. */
    protected HttpResponse<String> loginWithHeaders(String email, String password, String... headers) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/v1/auth/login"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(Map.of("email", email, "password", password))));
        for (int i = 0; i < headers.length; i += 2) b.header(headers[i], headers[i + 1]);
        return client.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }
    protected HttpResponse<String> login(String email, String password) throws Exception {
        return post("/api/v1/auth/login", Map.of("email", email, "password", password));
    }

    /** Registers a user and logs in; returns the access token. */
    protected String tokenFor(String email) throws Exception {
        register(email, PASSWORD);
        return body(login(email, PASSWORD)).get("accessToken").asString();
    }


    /** A request with a bearer token (a null token sends none, a null body sends none). */
    protected HttpResponse<String> send(String method, String path, String token, String body) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).header("Content-Type", "application/json")
                                .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
        if (token != null) b.header("Authorization", "Bearer " + token);
        return client.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }
}