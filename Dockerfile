# Build stage
FROM gradle:8.5-jdk17 AS build
WORKDIR /app
COPY . .
RUN chmod +x ./gradlew
RUN ./gradlew :loglens-backend:build -x test

# Runtime stage
FROM eclipse-temurin:17-jdk-alpine
WORKDIR /app

RUN addgroup -S spring && adduser -S spring -G spring
USER spring:spring
COPY --from=build /app/loglens-backend/build/libs/loglens-backend-1.0.0-SNAPSHOT.jar app.jar
EXPOSE 8080
# JVM optimizations for Render.com free tier (512MB RAM limit)
# Aggressive memory reduction settings:
# - MaxRAMPercentage=50: Use only 50% of RAM for heap (~256MB)
# - UseSerialGC: Lower memory overhead than G1GC for small heaps
# - MaxMetaspaceSize: Limit metaspace to prevent growth
# - ReservedCodeCacheSize: Limit JIT code cache
# - Xss256k: Reduce thread stack size
ENTRYPOINT ["java", \
    "-XX:+UseContainerSupport", \
    "-XX:MaxRAMPercentage=50.0", \
    "-XX:+UseSerialGC", \
    "-XX:MaxMetaspaceSize=128m", \
    "-XX:ReservedCodeCacheSize=64m", \
    "-Xss256k", \
    "-Djava.security.egd=file:/dev/./urandom", \
    "-jar", "app.jar"]

