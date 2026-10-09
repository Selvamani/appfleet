package io.appfleet.identity.auth;

import io.appfleet.identity.config.JwksProperties;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * The public keys, for every service that validates our tokens. Open (it is public by nature) and cacheable: a verifier may keep
 * it for cacheMaxAge. Not under /api, so the annotation test leaves it alone; it has nothing to authorise.
 */
@RestController
public class JwksController {

    private final JwkSetService keys;
    private final JwksProperties properties;

    public JwksController(JwkSetService keys, JwksProperties properties) {
        this.keys = keys;
        this.properties = properties;
    }

    @GetMapping(value = "/.well-known/jwks.json", produces = MediaType.APPLICATION_JSON_VALUE)
    ResponseEntity<Map<String, Object>> jwks() {
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(properties.cacheMaxAge()).cachePublic())
                .body(keys.publicSet().toJSONObject(true));      // true = public parts only
    }
}