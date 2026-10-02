package io.appfleet.control.web.openapi;


import io.swagger.v3.oas.models.Operation;
import io.swagger.v3.oas.models.media.StringSchema;
import io.swagger.v3.oas.models.parameters.HeaderParameter;
import io.swagger.v3.oas.models.responses.ApiResponse;
import org.springdoc.core.customizers.OperationCustomizer;
import org.springframework.stereotype.Component;
import org.springframework.web.method.HandlerMethod;


@Component
public class ErrorResponseCustomizer implements OperationCustomizer {

    @Override
    public Operation customize(Operation op, HandlerMethod method) {
        // 1. global answers: every operation can be 400 and 429
        add(op, ProblemKind.VALIDATION_FAILED);
        add(op, ProblemKind.RATE_LIMITED);

        // 2. the answers this method lists with @ProblemResponses
        ProblemResponses extra = method.getMethodAnnotation(ProblemResponses.class);
        if (extra != null) for (ProblemKind k : extra.value()) add(op, k);

        // 3. the header the interceptor reads, which no controller declares
        op.addParametersItem(new HeaderParameter().name("X-Team-Id").required(false)
                .description("TEMPORARY, replaced by the JWT in S4. Absent means the shared 'anonymous' bucket.")
                .schema(new StringSchema().format("uuid")));

        // 4. springdoc says */* for a ResponseEntity; the API answers application/json.
        //    Done here, not with produces= on the controllers, so no runtime behaviour changes.
        op.getResponses().values().forEach(r -> {
            if (r.getContent() != null && r.getContent().containsKey("*/*"))
                r.getContent().addMediaType("application/json", r.getContent().remove("*/*"));
        });
        return op;
    }

    private static void add(Operation op, ProblemKind k) {
        op.getResponses().addApiResponse(String.valueOf(k.status()),
                new ApiResponse().$ref("#/components/responses/" + ProblemKind.responseName(k.status())));
    }
}