package io.appfleet.control.web;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.stereotype.Component;

import java.util.UUID;

/** TEMPORARY until S4: trusts a client-supplied header. Spoofable on purpose (decision 4). */
@Component
public class HeaderTeamResolver implements TeamResolver {

    static final String HEADER = "X-Team-Id";
    static final String ANONYMOUS = "anonymous";

    @Override
    public String resolve(HttpServletRequest request) {
        String raw = request.getHeader(HEADER);
        if (raw == null) {
            return ANONYMOUS;                                   // no header: one shared bucket
        }
        try {
            UUID parsed = UUID.fromString(raw);
            if (!parsed.toString().equalsIgnoreCase(raw)) {     // reject lenient forms like "1-1-1-1-1"
                throw new IllegalArgumentException("not canonical");
            }
            return parsed.toString();                           // always lower case: one bucket per team
        } catch (IllegalArgumentException e) {
            throw new InvalidHeaderException(HEADER);
        }
    }
}

