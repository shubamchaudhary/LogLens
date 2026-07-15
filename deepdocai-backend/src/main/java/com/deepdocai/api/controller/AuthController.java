package com.deepdocai.api.controller;

import com.deepdocai.api.dto.request.LoginRequest;
import com.deepdocai.api.dto.request.RegisterRequest;
import com.deepdocai.api.dto.response.AuthResponse;
import com.deepdocai.api.security.JwtTokenProvider;
import com.deepdocai.data.entity.User;
import com.deepdocai.data.repository.UserRepository;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;

@RestController
@RequestMapping("/api/v1/auth")
@RequiredArgsConstructor
public class AuthController {
    
    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final JwtTokenProvider tokenProvider;

    @org.springframework.beans.factory.annotation.Value("${chunkai.guest.session-id:}")
    private String guestSessionId;

    @org.springframework.beans.factory.annotation.Value("${chunkai.guest.email:guest@chunkai.demo}")
    private String guestEmail;
    
    @PostMapping("/register")
    public ResponseEntity<AuthResponse> register(@Valid @RequestBody RegisterRequest request) {
        if (userRepository.existsByEmail(request.getEmail())) {
            return ResponseEntity.status(HttpStatus.CONFLICT).build();
        }
        
        User user = User.builder()
            .email(request.getEmail())
            .passwordHash(passwordEncoder.encode(request.getPassword()))
            .fullName(request.getFullName())
            .isActive(true)
            .build();
        
        user = userRepository.save(user);
        
        String token = tokenProvider.generateToken(user.getId(), user.getEmail());
        
        AuthResponse response = AuthResponse.builder()
            .userId(user.getId())
            .email(user.getEmail())
            .token(token)
            .expiresIn(86400L) // 24 hours in seconds
            .build();
        
        return ResponseEntity.status(HttpStatus.CREATED).body(response);
    }
    
    @PostMapping("/login")
    public ResponseEntity<AuthResponse> login(@Valid @RequestBody LoginRequest request) {
        User user = userRepository.findByEmail(request.getEmail())
            .orElse(null);
        
        if (user == null || !passwordEncoder.matches(request.getPassword(), user.getPasswordHash())) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        
        if (!user.getIsActive()) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        
        user.setLastLoginAt(Instant.now());
        userRepository.save(user);
        
        String token = tokenProvider.generateToken(user.getId(), user.getEmail());
        
        AuthResponse response = AuthResponse.builder()
            .userId(user.getId())
            .email(user.getEmail())
            .token(token)
            .expiresIn(86400L)
            .build();
        
        return ResponseEntity.ok(response);
    }

    /**
     * Guest login for recruiters/demos. Creates or retrieves a fixed guest
     * account and issues a JWT. The frontend uses the returned guestSessionId
     * to land directly on the precomputed analysis.
     */
    @PostMapping("/guest")
    public ResponseEntity<?> guestLogin() {
        if (guestSessionId == null || guestSessionId.isBlank()) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .body("Guest login is not configured (GUEST_SESSION_ID not set)");
        }

        User user = userRepository.findByEmail(guestEmail).orElseGet(() -> {
            User guest = User.builder()
                .email(guestEmail)
                .passwordHash(passwordEncoder.encode("guest-no-login"))
                .fullName("Guest")
                .isActive(true)
                .build();
            return userRepository.save(guest);
        });

        String token = tokenProvider.generateToken(user.getId(), user.getEmail());

        return ResponseEntity.ok(java.util.Map.of(
            "userId", user.getId().toString(),
            "email", user.getEmail(),
            "token", token,
            "expiresIn", 86400L,
            "guestSessionId", guestSessionId,
            "guest", true
        ));
    }
}
