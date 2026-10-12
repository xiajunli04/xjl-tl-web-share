package com.xjl.tl.common.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

import java.time.Duration;
import java.util.List;

/**
 * 应用自定义配置（app.*），均来自环境变量。
 */
@ConfigurationProperties(prefix = "app")
public record AppProperties(Security security, Crypto crypto, Admin admin, Cors cors, Ai ai) {

    /**
     * @param jwtSecret      JWT HS256 签名密钥（至少 32 字节）
     * @param accessTokenTtl 访问令牌有效期
     * @param refreshTokenTtl 刷新令牌有效期
     */
    public record Security(String jwtSecret,
                           @DefaultValue("2h") Duration accessTokenTtl,
                           @DefaultValue("7d") Duration refreshTokenTtl,
                           @DefaultValue("5") int loginMaxFailures,
                           @DefaultValue("15m") Duration loginFailWindow) {
    }

    /** @param modelKeySecret base64 编码的 32 字节 AES 密钥 */
    public record Crypto(String modelKeySecret) {
    }

    /** 初始管理员。 */
    public record Admin(String username, String password) {
    }

    public record Cors(@DefaultValue("http://localhost:3000") List<String> allowedOrigins) {
    }

    /**
     * @param baseUrl        Python AI 服务地址
     * @param internalToken  内部接口共享令牌
     */
    public record Ai(@DefaultValue("http://localhost:8000") String baseUrl,
                     String internalToken,
                     @DefaultValue("3s") Duration connectTimeout,
                     @DefaultValue("60s") Duration readTimeout) {
    }
}
