package io.appfleet.control.web;

import org.junit.jupiter.api.Test;
import org.springframework.test.context.TestPropertySource;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

@TestPropertySource(properties = "springdoc.swagger-ui.enabled=false")
class SwaggerUiDisabledTest extends WebIntegrationTest {

    @Test
    void swaggerUiHtml_isNotServed() throws Exception {
        assertThat(mockMvc.perform(get("/swagger-ui.html")).andReturn().getResponse().getStatus()).isEqualTo(404);
    }

    @Test
    void swaggerUiIndex_isNotServed() throws Exception {
        assertThat(mockMvc.perform(get("/swagger-ui/index.html")).andReturn().getResponse().getStatus()).isEqualTo(404);
    }

    @Test
    void apiDocs_areStillServed() throws Exception {
        assertThat(mockMvc.perform(get("/v3/api-docs")).andReturn().getResponse().getStatus()).isEqualTo(200);
        assertThat(mockMvc.perform(get("/v3/api-docs/api-v1")).andReturn().getResponse().getStatus()).isEqualTo(200);
    }
}
