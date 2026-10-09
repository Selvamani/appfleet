package io.appfleet.identity.admin;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

/** At start-up: if appfleet.identity.bootstrap.admin-email names a registered user, make them platform ADMIN. Idempotent. */
@Component
public class PlatformBootstrapRunner implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(PlatformBootstrapRunner.class);

    private final PlatformAdmins admins;
    private final String email;

    public PlatformBootstrapRunner(PlatformAdmins admins, @Value("${appfleet.identity.bootstrap.admin-email:}") String email) {
        this.admins = admins;
        this.email = email;
    }

    @Override
    public void run(ApplicationArguments args) {
        if (email.isBlank()) return;
        boolean made = admins.promote(email);
        log.info("bootstrap platform admin: {}", made ? "granted to " + email : "nothing to do for " + email + " (unknown user or already an administrator)");
    }
}