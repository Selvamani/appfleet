package io.appfleet.control.web.openapi;

import io.swagger.v3.oas.models.examples.Example;
import io.swagger.v3.oas.models.headers.Header;
import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.media.*;
import io.swagger.v3.oas.models.responses.ApiResponse;
import org.springdoc.core.models.GroupedOpenApi;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.*;
import java.util.stream.Collectors;

@Configuration
public class OpenApiConfig {

    @Bean
    OpenAPI appfleetOpenApi() {
        OpenAPI api = new OpenAPI().info(new Info()
                .title("Appfleet control-api")
                .version("v1")
                .description("Deployment control plane. Errors use one shape, application/problem+json; "
                        + "clients switch on `type`, never on `detail`."));
        Components c = new Components();
        c.addSchemas("Problem", problemSchema());
        Map<Integer, List<ProblemKind>> byStatus = Arrays.stream(ProblemKind.values())
                .collect(Collectors.groupingBy(ProblemKind::status, TreeMap::new, Collectors.toList()));
        byStatus.forEach((status, kinds) -> c.addResponses(ProblemKind.responseName(status), statusResponse(kinds)));
        return api.components(c);
    }

    @Bean
    GroupedOpenApi apiV1(ErrorResponseCustomizer customizer) {
        return GroupedOpenApi.builder()
                .group("api-v1")
                .pathsToMatch("/api/v1/**")
                .addOperationCustomizer(customizer)
                .build();
    }

    // Hand-built, so there is no unused ProblemSchema class to "clean up". The 'errors' list exists only on 400.
    private static Schema<?> problemSchema() {
        return new ObjectSchema()
                .addProperty("type", new StringSchema().example("urn:appfleet:problem:not-found"))
                .addProperty("title", new StringSchema())
                .addProperty("status", new IntegerSchema())
                .addProperty("detail", new StringSchema())
                .addProperty("instance", new StringSchema())
                .addProperty("correlationId", new StringSchema())
                .addProperty("errors", new ArraySchema().items(new ObjectSchema()
                        .addProperty("field", new StringSchema())
                        .addProperty("message", new StringSchema())))
                .required(List.of("type", "title", "status"));
    }

    private static ApiResponse statusResponse(List<ProblemKind> kinds) {
        MediaType mt = new MediaType().schema(new Schema<>().$ref("#/components/schemas/Problem"));
        for (ProblemKind k : kinds) {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("type", "urn:appfleet:problem:" + k.slug());
            body.put("title", k.title());
            body.put("status", k.status());
            mt.addExamples(k.slug(), new Example().summary(k.title()).value(body));   // addExamples: guessed name
        }
        ApiResponse r = new ApiResponse()
                .description(kinds.stream().map(ProblemKind::slug).collect(Collectors.joining(", ")))
                .content(new Content().addMediaType("application/problem+json", mt));
        List<ProblemKind> withRetry = kinds.stream().filter(k -> k.retryAfter() > 0).toList();
        if (!withRetry.isEmpty())
            r.addHeaderObject("Retry-After", new Header()
                    .description("Seconds to wait. Set by: " + withRetry.stream().map(ProblemKind::slug).collect(Collectors.joining(", ")))
                    .schema(new IntegerSchema()).example(withRetry.get(0).retryAfter()));   // an int, not a String
        return r;
    }
}
