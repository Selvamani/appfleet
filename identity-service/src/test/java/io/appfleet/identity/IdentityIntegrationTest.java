package io.appfleet.identity;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.lifecycle.Startables;

/**
 * One Postgres per JVM. Real HTTP port, because MockMvc skips the security filter chain
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "spring.jpa.properties.hibernate.generate_statistics=true",
        "appfleet.identity.jwt.private-key-location=classpath:keys/dev-private.pem",
        "appfleet.identity.password.bcrypt-cost=4",
        // the validating side, from common-security, so a test can decode what the issuer signed
        "appfleet.security.jwt.public-key-location=classpath:keys/dev-public.pem",
        "appfleet.security.jwt.issuer=appfleet-identity",
        "appfleet.security.jwt.denylist.enabled=true"
})
public abstract class IdentityIntegrationTest {

    @ServiceConnection
    static final PostgreSQLContainer<?> postgres =
            new PostgreSQLContainer<>("postgres:16").withUrlParam("currentSchema", "identity");

    @ServiceConnection(name = "redis")
    static final GenericContainer<?> redis = new GenericContainer<>("redis:7").withExposedPorts(6379);

    static {
        Startables.deepStart(postgres, redis).join();
    }

    @Autowired
    protected JdbcTemplate jdbc;
}