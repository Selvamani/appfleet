package io.appfleet.agent.runtime;

import java.util.Map;

public record ContainerSpec(String image, String nodeId, double cpuLimit, long memoryLimitMb, Map<String,String> env){

}
