package com.xjl.tl.module.translate;

import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.FieldError;

import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * 支持的 15 种语种（见 design D3）。Python 维护同一份映射。
 */
public enum SupportedLanguage {

    ZH("zh", "中文", "中文"),
    EN("en", "英语", "English"),
    JA("ja", "日语", "日本語"),
    KO("ko", "韩语", "한국어"),
    FR("fr", "法语", "Français"),
    DE("de", "德语", "Deutsch"),
    ES("es", "西班牙语", "Español"),
    RU("ru", "俄语", "Русский"),
    PT("pt", "葡萄牙语", "Português"),
    IT("it", "意大利语", "Italiano"),
    AR("ar", "阿拉伯语", "العربية"),
    TH("th", "泰语", "ไทย"),
    VI("vi", "越南语", "Tiếng Việt"),
    ID("id", "印尼语", "Bahasa Indonesia"),
    TR("tr", "土耳其语", "Türkçe");

    /** 源语言自动识别。 */
    public static final String AUTO = "auto";

    private static final Map<String, SupportedLanguage> BY_CODE =
            Arrays.stream(values()).collect(Collectors.toMap(SupportedLanguage::code, Function.identity()));

    private final String code;
    private final String cnName;
    private final String nativeName;

    SupportedLanguage(String code, String cnName, String nativeName) {
        this.code = code;
        this.cnName = cnName;
        this.nativeName = nativeName;
    }

    public String code() {
        return code;
    }

    public String cnName() {
        return cnName;
    }

    public String nativeName() {
        return nativeName;
    }

    public static boolean isSupported(String code) {
        return code != null && BY_CODE.containsKey(code);
    }

    /** 校验语种代码，不支持时抛出 A0420（data 中带字段名）。 */
    public static void require(String field, String code) {
        if (!isSupported(code)) {
            throw new BizException(ErrorCode.LANGUAGE_UNSUPPORTED, ErrorCode.LANGUAGE_UNSUPPORTED.getMessage() + "：" + code,
                    List.of(new FieldError(field, "不支持的语种")));
        }
    }

    /** 源语言：允许 auto。 */
    public static void requireSource(String field, String code) {
        if (!AUTO.equals(code)) {
            require(field, code);
        }
    }
}
