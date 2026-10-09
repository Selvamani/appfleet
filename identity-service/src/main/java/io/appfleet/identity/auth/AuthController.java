package io.appfleet.identity.auth;

import io.appfleet.identity.audit.ClientInfo;
import io.appfleet.identity.auth.AuthDTOs.LoginRequest;
import io.appfleet.identity.auth.AuthDTOs.RegisterRequest;
import io.appfleet.identity.auth.AuthDTOs.RegisteredUser;
import io.appfleet.identity.auth.AuthDTOs.TokenResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

    private final AuthService auth;

    public AuthController(AuthService auth) {
        this.auth = auth;
    }

    @PostMapping("/register")
    ResponseEntity<RegisteredUser> register(@Valid @RequestBody RegisterRequest request) {
        return ResponseEntity.status(HttpStatus.CREATED).body(auth.register(request));
    }

    /**
     * A token response must not be cached anywhere (RFC 6749). The Cache-Control and Pragma headers come
     * from Spring Security's default header writers, not from this method; LoginTest pins the result.
     */
    @PostMapping("/login")
    ResponseEntity<TokenResponse> login(@Valid @RequestBody LoginRequest request, HttpServletRequest http) {
        return ResponseEntity.ok(auth.login(request, ClientInfo.from(http)));
    }

    /** 204 whether or not the token was known: the answer must not tell a thief which tokens exist. */
    @PostMapping("/logout")
    ResponseEntity<Void> logout(@Valid @RequestBody AuthDTOs.LogoutRequest request) {
        auth.logout(request.refreshToken());
        return ResponseEntity.noContent().build();
    }

    /** The refusal is thrown HERE, after AuthService.refresh has committed, so a family revocation survives it. */
    @PostMapping("/refresh")
    ResponseEntity<TokenResponse> refresh(@Valid @RequestBody AuthDTOs.RefreshRequest request, HttpServletRequest http) {
        return ResponseEntity.ok(auth.refresh(request, ClientInfo.from(http)).orElseThrow(AuthExceptions.InvalidRefreshTokenException::new));
    }
}
