package com.xjl.tl.common.crypto;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.io.InputStream;
import java.util.Base64;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 5.2：AES-GCM 往返一致，并能解开与 Python 共用的跨语言测试向量。
 */
class AesGcmCipherTest {

    private static final String KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

    @Test
    void roundTrip() {
        AesGcmCipher cipher = new AesGcmCipher(KEY);
        String c1 = cipher.encrypt("sk-abcdef123456");
        String c2 = cipher.encrypt("sk-abcdef123456");
        assertThat(c1).startsWith("v1:").doesNotContain("sk-abcdef123456");
        assertThat(c1).as("随机 iv").isNotEqualTo(c2);
        assertThat(cipher.decrypt(c1)).isEqualTo("sk-abcdef123456");
        assertThat(cipher.decrypt(cipher.encrypt(""))).isEmpty();
    }

    @Test
    void decryptsAllCrossLanguageVectors() throws Exception {
        JsonNode root;
        try (InputStream in = getClass().getResourceAsStream("/crypto-vectors.json")) {
            root = JsonMapper.builder().build().readTree(in);
        }
        AesGcmCipher cipher = new AesGcmCipher(root.get("key").asString());
        assertThat(root.get("vectors").size()).isGreaterThanOrEqualTo(3);
        for (JsonNode v : root.get("vectors")) {
            String expected = v.get("plaintext").asString();
            assertThat(cipher.decrypt(v.get("cipher").asString())).isEqualTo(expected);
            // 用相同 iv 加密应得到完全一致的密文，证明格式 iv||ct||tag 一致
            byte[] iv = Base64.getDecoder().decode(v.get("iv").asString());
            assertThat(cipher.encrypt(expected, iv)).isEqualTo(v.get("cipher").asString());
        }
    }

    @Test
    void rejectsTamperedOrWrongKey() {
        AesGcmCipher cipher = new AesGcmCipher(KEY);
        String c = cipher.encrypt("secret");
        AesGcmCipher other = new AesGcmCipher(Base64.getEncoder().encodeToString(new byte[32]));
        assertThatThrownBy(() -> other.decrypt(c)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> cipher.decrypt("v2:abc")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void rejectsInvalidKey() {
        assertThatThrownBy(() -> new AesGcmCipher(Base64.getEncoder().encodeToString(new byte[16])))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new AesGcmCipher("")).isInstanceOf(IllegalArgumentException.class);
    }
}
