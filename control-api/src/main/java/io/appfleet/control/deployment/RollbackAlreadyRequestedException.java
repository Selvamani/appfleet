package io.appfleet.control.deployment;

import java.util.UUID;

public class RollbackAlreadyRequestedException extends RuntimeException {
    public RollbackAlreadyRequestedException(UUID deploymentId) {
        super("Rollback already pending for deployment " + deploymentId);
    }
}
