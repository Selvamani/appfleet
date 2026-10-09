package io.appfleet.identity.user;

import io.appfleet.identity.common.Uuidv7;
import jakarta.persistence.*;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Locale;
import java.util.UUID;

@Entity
@Table(name = "app_user")
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

    public void rename(String displayName) {
        this.displayName = displayName;
    }

    public void changePasswordHash(String passwordHash) {
        this.passwordHash = passwordHash;
    }

    /** Users are deactivated, never deleted (audit integrity). Calling it twice changes nothing. */
    public void deactivate() {
        if (status == UserStatus.DEACTIVATED) return;
        status = UserStatus.DEACTIVATED;
        deactivatedAt = Instant.now().truncatedTo(ChronoUnit.MICROS);
    }

    public UUID getId() {
        return id;
    }

    public String getEmail() {
        return email;
    }

    public String getDisplayName() {
        return displayName;
    }

    public String getPasswordHash() {
        return passwordHash;
    }

    public UserStatus getStatus() {
        return status;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getDeactivatedAt() {
        return deactivatedAt;
    }
}
