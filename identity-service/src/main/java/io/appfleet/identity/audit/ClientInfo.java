package io.appfleet.identity.audit;

import io.appfleet.identity.web.CorrelationIdFilter;
import jakarta.servlet.http.HttpServletRequest;

/**
 * Who is calling, as far as the audit may say. The address is the TCP peer. X-Forwarded-For is deliberately NOT read:
 * any client can send it, so trusting it would let an attacker write any address into the audit. Behind a reverse
 * proxy, the proxy's address is recorded until the deployment says which proxies are trusted.
 */
public record ClientInfo(String ip, String userAgent, String correlationId) {

    public static ClientInfo from(HttpServletRequest request) {
        Object cid = request.getAttribute(CorrelationIdFilter.ATTRIBUTE);
        return new ClientInfo(request.getRemoteAddr(), request.getHeader("User-Agent"), cid == null ? null : cid.toString());
    }
}