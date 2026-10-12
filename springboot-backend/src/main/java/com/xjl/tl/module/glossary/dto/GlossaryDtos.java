package com.xjl.tl.module.glossary.dto;

import com.xjl.tl.common.PageQuery;
import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * 术语库与术语 DTO（字段契约见 design D7）。
 */
public final class GlossaryDtos {

    public static final String SCOPE_REGEX = "^(PRIVATE|PUBLIC)$";

    private GlossaryDtos() {
    }

    @Schema(description = "术语库")
    public record GlossaryVO(
            @Schema(description = "id") Long id,
            @Schema(description = "名称") String name,
            @Schema(description = "描述") String description,
            @Schema(description = "源语言代码", example = "en") String sourceLang,
            @Schema(description = "目标语言代码", example = "zh") String targetLang,
            @Schema(description = "领域", example = "计算机") String domain,
            @Schema(description = "可见范围", allowableValues = {"PRIVATE", "PUBLIC"}) String scope,
            @Schema(description = "术语数") Integer termCount,
            @Schema(description = "拥有者 id") Long ownerId,
            @Schema(description = "拥有者名称（昵称，缺省为用户名）") String ownerName,
            @Schema(description = "当前用户是否可编辑") Boolean editable,
            @Schema(description = "创建时间") OffsetDateTime createdAt,
            @Schema(description = "更新时间") OffsetDateTime updatedAt) {
    }

    @Schema(description = "新建/编辑术语库")
    public record GlossaryRequest(
            @Schema(description = "名称") @NotBlank(message = "名称不能为空") @Size(max = 64, message = "名称最长 64 位") String name,
            @Schema(description = "描述") @Size(max = 255, message = "描述最长 255 位") String description,
            @Schema(description = "源语言代码", example = "en") @NotBlank(message = "源语言不能为空") String sourceLang,
            @Schema(description = "目标语言代码", example = "zh") @NotBlank(message = "目标语言不能为空") String targetLang,
            @Schema(description = "领域") @Size(max = 32, message = "领域最长 32 位") String domain,
            @Schema(description = "可见范围，缺省为 PRIVATE；PUBLIC 仅管理员可设", allowableValues = {"PRIVATE", "PUBLIC"})
            @Pattern(regexp = SCOPE_REGEX, message = "可见范围只能是 PRIVATE 或 PUBLIC") String scope) {
    }

    @Schema(description = "术语库查询条件：返回自己的术语库和全部公共术语库")
    public static class GlossaryQuery extends PageQuery {
        @Schema(description = "关键字（匹配名称，不区分大小写）")
        private String keyword;
        @Schema(description = "可见范围", allowableValues = {"PRIVATE", "PUBLIC"})
        private String scope;
        @Schema(description = "源语言代码")
        private String sourceLang;
        @Schema(description = "目标语言代码")
        private String targetLang;

        public String getKeyword() {
            return keyword;
        }

        public void setKeyword(String keyword) {
            this.keyword = keyword;
        }

        public String getScope() {
            return scope;
        }

        public void setScope(String scope) {
            this.scope = scope;
        }

        public String getSourceLang() {
            return sourceLang;
        }

        public void setSourceLang(String sourceLang) {
            this.sourceLang = sourceLang;
        }

        public String getTargetLang() {
            return targetLang;
        }

        public void setTargetLang(String targetLang) {
            this.targetLang = targetLang;
        }
    }

    @Schema(description = "术语")
    public record TermVO(
            @Schema(description = "id") Long id,
            @Schema(description = "源术语") String sourceTerm,
            @Schema(description = "目标术语") String targetTerm,
            @Schema(description = "备注") String note,
            @Schema(description = "是否区分大小写") Boolean caseSensitive,
            @Schema(description = "更新时间") OffsetDateTime updatedAt) {
    }

    @Schema(description = "新增/编辑术语")
    public record TermRequest(
            @Schema(description = "源术语（同一术语库内不区分大小写唯一）") @NotBlank(message = "源术语不能为空")
            @Size(max = 200, message = "源术语最长 200 位") String sourceTerm,
            @Schema(description = "目标术语") @NotBlank(message = "目标术语不能为空")
            @Size(max = 200, message = "目标术语最长 200 位") String targetTerm,
            @Schema(description = "备注") @Size(max = 255, message = "备注最长 255 位") String note,
            @Schema(description = "是否区分大小写，默认 false") Boolean caseSensitive) {
    }

    @Schema(description = "术语查询条件")
    public static class TermQuery extends PageQuery {
        @Schema(description = "关键字（匹配源术语或目标术语，不区分大小写）")
        private String keyword;

        public String getKeyword() {
            return keyword;
        }

        public void setKeyword(String keyword) {
            this.keyword = keyword;
        }
    }

    @Schema(description = "导入错误行")
    public record ImportError(@Schema(description = "文件中的行号（表头为第 1 行）") int line,
                              @Schema(description = "错误说明") String message) {
    }

    @Schema(description = "导入样例行")
    public record ImportSample(@Schema(description = "行号") int line,
                               @Schema(description = "源术语") String sourceTerm,
                               @Schema(description = "目标术语") String targetTerm,
                               @Schema(description = "备注") String note,
                               @Schema(description = "是否与已有术语冲突（导入时按策略跳过或覆盖）") boolean exists) {
    }

    @Schema(description = "导入预览")
    public record ImportPreviewVO(
            @Schema(description = "数据行总数（不含表头与空行）") int total,
            @Schema(description = "有效行数") int valid,
            @Schema(description = "将新增的条数") int newCount,
            @Schema(description = "与已有术语冲突的条数（overwrite 时覆盖）") int updateCount,
            @Schema(description = "错误行（最多返回 200 条）") List<ImportError> errors,
            @Schema(description = "有效行样例（最多 10 条）") List<ImportSample> sample) {
    }

    @Schema(description = "导入结果")
    public record ImportResultVO(@Schema(description = "新增条数") int inserted,
                                 @Schema(description = "覆盖条数") int updated,
                                 @Schema(description = "跳过条数") int skipped,
                                 @Schema(description = "失败（错误行）条数") int failed) {
    }
}
