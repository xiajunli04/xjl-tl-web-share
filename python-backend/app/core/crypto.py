"""模型 API Key 加解密：AES-256-GCM，格式 v1:base64(iv[12] || ciphertext || tag[16])，无 AAD（design D7）。"""

import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

PREFIX = "v1:"
IV_LEN = 12


class CryptoError(Exception):
    pass


def _key(secret_b64: str) -> bytes:
    try:
        key = base64.b64decode(secret_b64, validate=True)
    except Exception as e:
        raise CryptoError("MODEL_KEY_SECRET 不是合法的 base64") from e
    if len(key) != 32:
        raise CryptoError("MODEL_KEY_SECRET 必须是 32 字节")
    return key


def decrypt(cipher_text: str, secret_b64: str) -> str:
    if not cipher_text.startswith(PREFIX):
        raise CryptoError("不支持的密文版本")
    try:
        raw = base64.b64decode(cipher_text[len(PREFIX) :], validate=True)
        iv, body = raw[:IV_LEN], raw[IV_LEN:]
        return AESGCM(_key(secret_b64)).decrypt(iv, body, None).decode("utf-8")
    except CryptoError:
        raise
    except Exception as e:
        raise CryptoError("密文解密失败") from e


def encrypt(plain_text: str, secret_b64: str, iv: bytes | None = None) -> str:
    """主要用于测试；生产中由 Spring 负责加密。"""
    iv = iv or os.urandom(IV_LEN)
    body = AESGCM(_key(secret_b64)).encrypt(iv, plain_text.encode("utf-8"), None)
    return PREFIX + base64.b64encode(iv + body).decode("ascii")
