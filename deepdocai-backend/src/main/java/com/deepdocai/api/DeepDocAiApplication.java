package com.deepdocai.api;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.domain.EntityScan;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;

@SpringBootApplication(scanBasePackages = "com.deepdocai")
@EntityScan("com.deepdocai.data.entity")
@EnableJpaRepositories("com.deepdocai.data.repository")
public class DeepDocAiApplication {
    
    public static void main(String[] args) {
        SpringApplication.run(DeepDocAiApplication.class, args);
    }
}

