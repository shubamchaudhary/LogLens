plugins {
    id("org.springframework.boot")
}

// All dependencies from examprep-api, examprep-core, examprep-data, examprep-llm, examprep-common
// merged into this single module.

dependencies {

    // ── Web / API layer ───────────────────────────────────────────────────────
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-webflux")   // WebClient for Gemini API
    implementation("org.springframework.boot:spring-boot-starter-security")
    implementation("org.springframework.boot:spring-boot-starter-validation")

    // ── Data layer ────────────────────────────────────────────────────────────
    implementation("org.springframework.boot:spring-boot-starter-data-jpa")
    implementation("org.postgresql:postgresql:42.7.1")
    implementation("com.pgvector:pgvector:0.1.4")

    // ── JWT authentication ────────────────────────────────────────────────────
    implementation("io.jsonwebtoken:jjwt-api:0.12.3")
    implementation("io.jsonwebtoken:jjwt-impl:0.12.3")
    implementation("io.jsonwebtoken:jjwt-jackson:0.12.3")
    implementation("org.springframework.security:spring-security-crypto")

    // ── API docs ──────────────────────────────────────────────────────────────
    implementation("org.springdoc:springdoc-openapi-starter-webmvc-ui:2.3.0")

    // ── JSON ──────────────────────────────────────────────────────────────────
    implementation("com.fasterxml.jackson.core:jackson-databind")

    // ── Messaging (Kafka LLM lanes) ───────────────────────────────────────────
    implementation("org.springframework.kafka:spring-kafka")

    // ── Object storage (MinIO staging blobs) ──────────────────────────────────
    implementation("io.minio:minio:8.5.17")

    // ── Document processing ───────────────────────────────────────────────────
    implementation("org.apache.poi:poi:5.2.5")           // Excel / old PPT
    implementation("org.apache.poi:poi-ooxml:5.2.5")     // PPTX / DOCX
    implementation("org.apache.poi:poi-scratchpad:5.2.5") // Legacy PPT
    implementation("org.apache.pdfbox:pdfbox:3.0.1")     // PDF text extraction

    // ── OCR ───────────────────────────────────────────────────────────────────
    implementation("net.sourceforge.tess4j:tess4j:5.10.0")

    // ── Test ──────────────────────────────────────────────────────────────────
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.springframework.security:spring-security-test")
    testImplementation("com.h2database:h2")
}
