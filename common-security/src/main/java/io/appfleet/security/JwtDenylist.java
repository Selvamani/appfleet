package io.appfleet.security;

/** A list of access tokens that must be refused although their signature and expiry are fine, identified by jti. */
public interface JwtDenylist {

    boolean isRevoked(String jti);
}