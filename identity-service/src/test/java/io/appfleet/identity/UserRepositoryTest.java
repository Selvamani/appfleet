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