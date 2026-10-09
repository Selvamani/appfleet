package io.appfleet.identity.serviceaccount;

import io.appfleet.identity.audit.ClientInfo;
import io.appfleet.identity.serviceaccount.ServiceAccountDTOs.ServiceTokenRequest;
import io.appfleet.identity.serviceaccount.ServiceAccountDTOs.ServiceTokenResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Open like the other auth endpoints: the caller has no token yet, the key IS the credential. Under /api/v1/auth, so the annotation test leaves it alone. */
@RestController
@RequestMapping("/api/v1/auth")
public class ServiceTokenController {

    private final ServiceTokenService tokens;

    public ServiceTokenController(ServiceTokenService tokens) {
        this.tokens = tokens;
    }

    /** The response must not be cached anywhere; Spring Security's default headers already say so, as for /login. */
    @PostMapping("/service-token")
    ResponseEntity<ServiceTokenResponse> exchange(@Valid @RequestBody ServiceTokenRequest request, HttpServletRequest http) {
        return ResponseEntity.ok(tokens.exchange(request.apiKey(), ClientInfo.from(http)));
    }
}