package io.appfleet.control.idempotency;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.HexFormat;
import java.util.UUID;
import java.util.function.Supplier;

@Component
public class IdempotencyExecutor {
    private static final Logger log = LoggerFactory.getLogger(IdempotencyExecutor.class);
    static final Duration IN_PROGRESS_TTL = Duration.ofSeconds(30);
    static final Duration COMPLETED_TTL = Duration.ofHours(24);

    private final IdempotencyStore store;
    private final JsonMapper json;

    public IdempotencyExecutor(IdempotencyStore store, JsonMapper json) {
        this.store = store;
        this.json = json;
    }

    public <T> Idempotent<T> execute(String key, Object request, Class<T> responseType, Supplier<T> action) {
        String fingerprint = fingerprint(request);
        String inProgress = json.writeValueAsString(IdempotencyRecord.inProgress(UUID.randomUUID().toString(), fingerprint));

        String existing = store.claim(key, inProgress, IN_PROGRESS_TTL);
        if(existing != null) {
            IdempotencyRecord record = json.readValue(existing, IdempotencyRecord.class);
            if(!record.fingerprint().equals(fingerprint)) {
                throw new IdempotencyKeyReusedException();
            }
            if(record.state() == IdempotencyRecord.State.IN_PROGRESS) {
                throw new RequestInProgressException();
            }
            return new Idempotent<>(json.readValue(record.response(), responseType), true);
        }

        T result;
        try {
            result = action.get();
        } catch (RuntimeException e) {
            try {
                store.release(key, inProgress);
            } catch (RuntimeException releaseFailure) {
                e.addSuppressed(releaseFailure);
            }
            throw e;
        }

        try {
            String completed = json.writeValueAsString(IdempotencyRecord.completed(fingerprint, json.writeValueAsString(result)));
            if(!store.complete(key, inProgress, completed, COMPLETED_TTL)) {
                log.warn("Idempotency claim for key {} expired before completion; the work is committed", key);
            }
        } catch (RuntimeException e) {
            log.warn("Could not complete idempotency record for key {}; the work is committed", key, e);
        }
        return new Idempotent<>(result, false);
    }

    private String fingerprint(Object request) {
        byte[] bytes = json.writeValueAsBytes(request);
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);   // SHA-256 is mandatory on every JVM
        }
    }
}