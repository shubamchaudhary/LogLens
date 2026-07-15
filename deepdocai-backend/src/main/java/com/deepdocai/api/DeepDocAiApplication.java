package com.deepdocai.api;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.domain.EntityScan;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication(scanBasePackages = "com.deepdocai")
@EntityScan("com.deepdocai.data.entity")
@EnableJpaRepositories("com.deepdocai.data.repository")
@EnableScheduling
public class DeepDocAiApplication {
    
    public static void main(String[] args) {
        SpringApplication.run(DeepDocAiApplication.class, args);
    }
}

