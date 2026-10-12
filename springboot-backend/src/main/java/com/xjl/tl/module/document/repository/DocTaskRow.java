package com.xjl.tl.module.document.repository;

import com.xjl.tl.module.document.dto.DocDtos.DocOptions;
import com.xjl.tl.module.document.dto.DocDtos.DocTaskVO;
import tools.jackson.databind.JsonNode;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * biz.doc_task 的一行（不含原文 source_text）。
 */
public record DocTaskRow(Long id, Long userId, String title, String format, Integer charCount, String sourceLang,
                         String detectedLang, String targetLang, String style, String domain, String genre,
                         List<Long> glossaryIds, Long modelConfigId, Long reviewModelConfigId, String strategy,
                         Boolean confirmTerms, DocOptions options, String status, String phase, Integer progressDone,
                         Integer progressTotal, String summary, JsonNode consistencyReport, JsonNode stats,
                         String errorCode, String errorMessage, Boolean retryable, Integer lastEventSeq,
                         OffsetDateTime lastEventAt, Integer promptTokens, Integer completionTokens,
                         Integer latencyMs, OffsetDateTime createdAt, OffsetDateTime startedAt,
                         OffsetDateTime finishedAt) {

    public DocTaskVO toVO() {
        return new DocTaskVO(id, title, format, charCount, sourceLang, detectedLang, targetLang, style, domain, genre,
                glossaryIds, modelConfigId, reviewModelConfigId, strategy, confirmTerms, options, status, phase,
                progressDone, progressTotal, summary, consistencyReport, stats, errorCode, errorMessage, retryable,
                promptTokens, completionTokens, latencyMs, createdAt, startedAt, finishedAt);
    }
}
