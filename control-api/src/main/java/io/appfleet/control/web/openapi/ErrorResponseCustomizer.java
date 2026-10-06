package io.appfleet.control.web.openapi;


import io.swagger.v3.oas.models.Operation;
import io.swagger.v3.oas.models.media.StringSchema;
import io.swagger.v3.oas.models.parameters.HeaderParameter;
import io.swagger.v3.oas.models.responses.ApiResponse;
import org.springdoc.core.customizers.OperationCustomizer;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.stereotype.Component;
import org.springframework.web.method.HandlerMethod;

import java.util.regex.Matcher;
import java.util.regex.Pattern;


@Component
public class ErrorResponseCustomizer implements OperationCustomizer {

    /** allows: hasAuthority('deployment:create'). Same pattern as PermissionEnforcementTest. */
    private static final Pattern AUTHORITY = Pattern.compile("hasAuthority\\('([a-z]+:[a-z]+)'\\)");

    @Override
    public Operation customize(Operation op, HandlerMethod method) {
        // 1. global answers: every operation can be 400, 401, 403 and 429
        add(op, ProblemKind.VALIDATION_FAILED);
        add(op, ProblemKind.UNAUTHORIZED);
        add(op, ProblemKind.FORBIDDEN);
        add(op, ProblemKind.RATE_LIMITED);

        // 2. the answers this method lists with @ProblemResponses
        ProblemResponses extra = method.getMethodAnnotation(ProblemResponses.class);
        if (extra != null) for (ProblemKind k : extra.value()) add(op, k);

        // 3. the permission, read from @PreAuthorize so the document cannot drift from the enforcement
        String permission = permissionOf(method);
        op.addExtension("x-required-permission", permission);
        String sentence = "Requires the permission `" + permission + "` for the object's team.";
        op.setDescription(op.getDescription() == null || op.getDescription().isBlank()
                ? sentence : op.getDescription() + "\n\n" + sentence);

        // 4. springdoc says */* for a ResponseEntity; the API answers application/json.
        //    Done here, not with produces= on the controllers, so no runtime behaviour changes.
        op.getResponses().values().forEach(r -> {
            if (r.getContent() != null && r.getContent().containsKey("*/*"))
                r.getContent().addMediaType("application/json", r.getContent().remove("*/*"));
        });
        return op;
    }

    private static String permissionOf(HandlerMethod method) {
        PreAuthorize pre = method.getMethodAnnotation(PreAuthorize.class);
        if (pre == null)
            throw new IllegalStateException("No @PreAuthorize on " + method.getShortLogMessage()
                    + ": every /api/v1 operation must state its permission (S4.3)");
        Matcher m = AUTHORITY.matcher(pre.value());
        if (!m.matches())
            throw new IllegalStateException("@PreAuthorize on " + method.getShortLogMessage()
                    + " is not hasAuthority('<resource>:<action>'): " + pre.value());
        return m.group(1);
    }

    private static void add(Operation op, ProblemKind k) {
        op.getResponses().addApiResponse(String.valueOf(k.status()),
                new ApiResponse().$ref("#/components/responses/" + ProblemKind.responseName(k.status())));
    }
}