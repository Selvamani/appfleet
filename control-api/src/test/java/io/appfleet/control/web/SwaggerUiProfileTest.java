package io.appfleet.control.web;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

class SwaggerUiProfileTest extends WebIntegrationTest {

    @Test
    void swaggerUiHtml_redirectsToTheUi() throws Exception {
        var r = mockMvc.perform(get("/swagger-ui.html")).andReturn().getResponse();
        assertThat(r.getStatus()).isEqualTo(302);
        assertThat(r.getHeader("Location")).endsWith("/swagger-ui/index.html");
    }

    @Test
    void swaggerUiIndex_isServed() throws Exception {
        var r = mockMvc.perform(get("/swagger-ui/index.html")).andReturn().getResponse();
        assertThat(r.getStatus()).isEqualTo(200);
        assertThat(r.getContentAsString()).containsIgnoringCase("swagger");
    }

    @Test
    void apiDocs_areServed() throws Exception {
        assertThat(mockMvc.perform(get("/v3/api-docs")).andReturn().getResponse().getStatus()).isEqualTo(200);
    }
}
