package io.appfleet.control;

import io.appfleet.control.config.AppfleetProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

@SpringBootApplication
@EnableConfigurationProperties(AppfleetProperties.class)
public class ControlApiApplication {

    public static void main(String[] args) {
        SpringApplication.run(ControlApiApplication.class, args);
    }
}
