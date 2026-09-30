package io.appfleet.control.deployment;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

public class DeploymentStateTest {

    private static final Set<String> LEGAL_PAIRS = Set.of(
            "PENDING->VALIDATING",
            "VALIDATING->DEPLOYING", "VALIDATING->FAILED",
            "DEPLOYING->HEALTHY",  "DEPLOYING->FAILED",
            "HEALTHY->DEGRADED", "HEALTHY->ROLLED_BACK",
            "DEGRADED->HEALTHY", "DEGRADED->ROLLED_BACK"
    );

    static List<Arguments> allStatePairs() {
        List<Arguments> pairs = new ArrayList<>();
        for(DeploymentState from : DeploymentState.values()) {
            for(DeploymentState to : DeploymentState.values()) {
                pairs.add(Arguments.of(from, to));
            }
        }
        return pairs;
    }

    @ParameterizedTest(name = "{0} -> {1}")
    @MethodSource("allStatePairs")
    void matchesMermaidDiagram(DeploymentState from, DeploymentState to) {
        boolean expectedLegal = LEGAL_PAIRS.contains(from+"->"+to);
        assertThat(from.canTransitionTo(to)).isEqualTo(expectedLegal);
    }

}
