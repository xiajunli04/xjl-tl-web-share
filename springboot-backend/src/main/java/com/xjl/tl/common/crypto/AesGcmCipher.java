package com.xjl.tl.common.crypto;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;

/**
 * AES-256-GCM 加解密（见 design D7）。
 * 存储格式：{@code v1:} + base64(iv[12] ‖ ciphertext ‖ tag[16])，无 AAD，与 Python cryptography AESGCM 兼容。
 */
public class AesGcmCipher {

    public static final String PREFIX = "v1:";
    private static final int IV_LENGTH = 12;
    private static final int TAG_BITS = 128;
    private static final SecureRandom RANDOM = new SecureRandom();

    private final SecretKeySpec key;

    /**
     * @param base64Key base64 编码的 32 字节密钥
     */
    public AesGcmCipher(String base64Key) {
        if (base64Key == null || base64Key.isBlank()) {
            throw new IllegalArgumentException("MODEL_KEY_SECRET 未配置");
        }
        byte[] raw;
        try {
            raw = Base64.getDecoder().decode(base64Key.trim());
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("MODEL_KEY_SECRET 不是合法的 base64", e);
        }
        if (raw.length != 32) {
            throw new IllegalArgumentException("MODEL_KEY_SECRET 必须是 base64 编码的 32 字节");
        }
        this.key = new SecretKeySpec(raw, "AES");
    }

    public String encrypt(String plaintext) {
        byte[] iv = new byte[IV_LENGTH];
        RANDOM.nextBytes(iv);
        return encrypt(plaintext, iv);
    }

    /** 指定 iv 加密，仅用于生成/校验测试向量。 */
    String encrypt(String plaintext, byte[] iv) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
            byte[] ctAndTag = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            byte[] out = new byte[iv.length + ctAndTag.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(ctAndTag, 0, out, iv.length, ctAndTag.length);
            return PREFIX + Base64.getEncoder().encodeToString(out);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("加密失败", e);
        }
    }

    public String decrypt(String stored) {
        if (stored == null || !stored.startsWith(PREFIX)) {
            throw new IllegalArgumentException("不支持的密文格式");
        }
        byte[] all = Base64.getDecoder().decode(stored.substring(PREFIX.length()));
        if (all.length < IV_LENGTH + TAG_BITS / 8) {
            throw new IllegalArgumentException("密文长度不正确");
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, Arrays.copyOfRange(all, 0, IV_LENGTH)));
            byte[] plain = cipher.doFinal(all, IV_LENGTH, all.length - IV_LENGTH);
            return new String(plain, StandardCharsets.UTF_8);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("解密失败", e);
        }
    }
}
