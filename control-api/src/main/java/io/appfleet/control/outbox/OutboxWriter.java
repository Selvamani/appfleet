package io.appfleet.control.outbox;

import io.appfleet.events.DeploymentCommand;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.json.JsonMapper;

@Component
public class OutboxWriter {

    private final OutboxMessageRepository repository;
    private final JsonMapper jsonMapper;

    public OutboxWriter(OutboxMessageRepository repository, JsonMapper jsonMapper) {
        this.repository = repository;
        this.jsonMapper = jsonMapper;
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void write(DeploymentCommand command) {
        repository.save(new OutboxMessage(command.deploymentId(), jsonMapper.writeValueAsString(command)));
    }

}
