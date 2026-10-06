package io.appfleet.control.web;

import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.assertThat;

public class ApplicationOwnerIndexTest  extends WebIntegrationTest {

    @Test
    void v5_createsTheOwnerTeamIndex_onOwnerTeamAndId() {
        String definition = jdbc.queryForObject(
                "select indexdef from pg_indexes where schemaname = 'control' and tablename = 'application' "
                        + "and indexname = 'idx_application_owner_team_id'",
                String.class);

        assertThat(definition).contains("(owner_team_id, id)");
    }

}
