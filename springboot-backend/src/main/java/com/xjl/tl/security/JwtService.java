package com.xjl.tl.security;

import com.xjl.tl.common.config.AppProperties;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * 访问令牌签发（HS256，见 design D3）。
 * claims：sub(userId)、username、roles、jti、iat、exp；另含毫秒级签发时间 iatMs，
 * 用于与 revoked-before 做精确比较（标准 iat 只有秒级精度）。
 */
@Service
public class JwtService {

    public static final String CLAIM_USERNAME = "username";
    public static final String CLAIM_ROLES = "roles";
    public static final String CLAIM_IAT_MS = "iatMs";

    private final JwtEncoder jwtEncoder;
    private final Duration accessTokenTtl;

    public JwtService(JwtEncoder jwtEncoder, AppProperties props) {
        this.jwtEncoder = jwtEncoder;
        this.accessTokenTtl = props.security().accessTokenTtl();
    }

    public IssuedToken issue(Long userId, String username, List<String> roles) {
        Instant now = Instant.now();
        Instant expiresAt = now.plus(accessTokenTtl);
        String jti = UUID.randomUUID().toString();
        JwtClaimsSet claims = JwtClaimsSet.builder()
                .subject(String.valueOf(userId))
                .claim(CLAIM_USERNAME, username)
                .claim(CLAIM_ROLES, roles)
                .claim(CLAIM_IAT_MS, now.toEpochMilli())
                .id(jti)
                .issuedAt(now)
                .expiresAt(expiresAt)
                .build();
        String token = jwtEncoder.encode(JwtEncoderParameters.from(
                JwsHeader.with(MacAlgorithm.HS256).build(), claims)).getTokenValue();
        return new IssuedToken(token, jti, accessTokenTtl.toSeconds());
    }

    public long accessTokenTtlSeconds() {
        return accessTokenTtl.toSeconds();
    }

    /** 已签发的访问令牌。 */
    public record IssuedToken(String token, String jti, long expiresIn) {
    }
}
