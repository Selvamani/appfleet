package io.appfleet.identity;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.core.context.SecurityContextHolder;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The two deliberate bugs of I6, as plain Spring contexts (no web, no database, so they run in milliseconds):
 * (1) @PreAuthorize with no @EnableMethodSecurity does nothing; (2) @PreAuthorize on a method that is called from
 * inside its own class is skipped, because the call never goes through the proxy.
 */
class MethodSecurityMechanicsTest {

    public static class Guarded {
        @PreAuthorize("hasAuthority('nobody:has')")
        public String secret() { return "secret"; }
    }

    /** The same proxy trap as @Transactional, but here it is a security hole. */
    public static class SelfCaller {
        public String entry() { return secret(); }          // this call is not intercepted

        @PreAuthorize("hasAuthority('nobody:has')")
        public String secret() { return "secret"; }
    }

    /** The fix: the guarded method lives in another bean, so the call crosses the proxy. */
    public static class Caller {
        private final Guarded guarded;

        public Caller(Guarded guarded) { this.guarded = guarded; }

        public String entry() { return guarded.secret(); }
    }

    @Configuration
    static class WithoutEnable {
        @Bean Guarded guarded() { return new Guarded(); }
    }

    @Configuration
    @EnableMethodSecurity
    static class WithEnable {
        @Bean Guarded guarded() { return new Guarded(); }
        @Bean SelfCaller selfCaller() { return new SelfCaller(); }
        @Bean Caller caller(Guarded guarded) { return new Caller(guarded); }
    }

    @BeforeEach
    void signIn() {
        SecurityContextHolder.getContext().setAuthentication(new TestingAuthenticationToken("someone", "x", "some:permission"));
    }

    @AfterEach
    void signOut() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void theAnnotationWithoutEnableMethodSecurity_enforcesNothing() {
        try (var ctx = new AnnotationConfigApplicationContext(WithoutEnable.class)) {
            assertThat(ctx.getBean(Guarded.class).secret()).as("annotation present, nothing enforced: the bug").isEqualTo("secret");
        }
    }

    @Test
    void withEnableMethodSecurity_theCallIsRefused() {
        try (var ctx = new AnnotationConfigApplicationContext(WithEnable.class)) {
            assertThatThrownBy(() -> ctx.getBean(Guarded.class).secret()).isInstanceOf(AccessDeniedException.class);
        }
    }

    @Test
    void aSelfInvokedMethod_isNotProtected_thisIsTheHole() {
        try (var ctx = new AnnotationConfigApplicationContext(WithEnable.class)) {
            assertThat(ctx.getBean(SelfCaller.class).entry()).as("the @PreAuthorize on secret() was skipped").isEqualTo("secret");
        }
    }

    @Disabled("Known hole, kept on purpose: this is what one would wish to be true. Enable it to see it fail; the fix is the next test.")
    @Test
    void aSelfInvokedMethod_shouldBeRefused() {
        try (var ctx = new AnnotationConfigApplicationContext(WithEnable.class)) {
            assertThatThrownBy(() -> ctx.getBean(SelfCaller.class).entry()).isInstanceOf(AccessDeniedException.class);
        }
    }

    @Test
    void anExtractedCollaborator_isProtected() {
        try (var ctx = new AnnotationConfigApplicationContext(WithEnable.class)) {
            assertThatThrownBy(() -> ctx.getBean(Caller.class).entry()).isInstanceOf(AccessDeniedException.class);
        }
    }
}