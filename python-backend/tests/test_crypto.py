import base64

import pytest

from app.core.crypto import CryptoError, decrypt, encrypt
from tests.conftest import VECTORS


@pytest.mark.parametrize("vec", VECTORS["vectors"], ids=lambda v: repr(v["plaintext"]))
def test_decrypt_cross_language_vectors(vec):
    assert decrypt(vec["cipher"], VECTORS["key"]) == vec["plaintext"]


@pytest.mark.parametrize("vec", VECTORS["vectors"], ids=lambda v: repr(v["plaintext"]))
def test_encrypt_matches_vectors_with_fixed_iv(vec):
    assert encrypt(vec["plaintext"], VECTORS["key"], iv=base64.b64decode(vec["iv"])) == vec["cipher"]


def test_decrypt_wrong_key_fails():
    wrong = base64.b64encode(bytes(32)).decode()
    with pytest.raises(CryptoError):
        decrypt(VECTORS["vectors"][0]["cipher"], wrong)


def test_decrypt_bad_prefix_fails():
    with pytest.raises(CryptoError):
        decrypt("v2:abc", VECTORS["key"])
