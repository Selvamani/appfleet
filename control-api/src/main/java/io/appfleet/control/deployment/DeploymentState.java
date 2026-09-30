package io.appfleet.control.deployment;

public enum DeploymentState {
    PENDING, VALIDATING, DEPLOYING, HEALTHY, DEGRADED, FAILED, ROLLED_BACK;

    public boolean canTransitionTo(DeploymentState target) {
        return switch (this) {
            case PENDING -> target == VALIDATING;
            case VALIDATING -> target == DEPLOYING || target == FAILED;
            case DEPLOYING -> target == HEALTHY || target == FAILED;
            case HEALTHY -> target == DEGRADED || target == ROLLED_BACK;
            case DEGRADED -> target == HEALTHY || target == ROLLED_BACK;
            case FAILED, ROLLED_BACK -> false;
        };
    }
}
