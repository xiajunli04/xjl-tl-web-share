package com.xjl.tl.common.config;

import com.xjl.tl.common.crypto.AesGcmCipher;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;

/**
 * 通用 Bean：配置属性、密码编码器、模型密钥加密器。
 */
@Configuration
@EnableConfigurationProperties({AppProperties.class, TranslateProperties.class, MediaProperties.class})
public class CommonConfig {

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }

    @Bean
    public AesGcmCipher aesGcmCipher(AppProperties props) {
        return new AesGcmCipher(props.crypto() == null ? null : props.crypto().modelKeySecret());
    }
}
