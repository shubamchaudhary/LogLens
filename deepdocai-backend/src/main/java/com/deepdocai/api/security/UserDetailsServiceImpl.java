package com.deepdocai.api.security;

import com.deepdocai.data.entity.User;
import com.deepdocai.data.repository.UserRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.core.userdetails.UsernameNotFoundException;
import org.springframework.stereotype.Service;

import java.util.UUID;

@Service
@RequiredArgsConstructor
public class UserDetailsServiceImpl implements UserDetailsService {
    
    private final UserRepository userRepository;
    
    @Override
    public UserDetails loadUserByUsername(String username) throws UsernameNotFoundException {
        User user;
        try {
            UUID userId = UUID.fromString(username);
            user = userRepository.findById(userId)
                .orElseThrow(() -> new UsernameNotFoundException("User not found: " + username));
        } catch (IllegalArgumentException e) {
            user = userRepository.findByEmail(username)
                .orElseThrow(() -> new UsernameNotFoundException("User not found: " + username));
        }
        
        return org.springframework.security.core.userdetails.User.builder()
            .username(user.getId().toString())
            .password(user.getPasswordHash())
            .authorities("ROLE_USER")
            .accountExpired(!user.getIsActive())
            .accountLocked(!user.getIsActive())
            .credentialsExpired(false)
            .disabled(!user.getIsActive())
            .build();
    }
}

