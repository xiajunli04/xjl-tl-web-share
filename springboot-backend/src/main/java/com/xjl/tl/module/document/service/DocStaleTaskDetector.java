package com.xjl.tl.module.document.service;

import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.module.document.DocProperties;
import com.xjl.tl.module.document.DocStatus;
import com.xjl.tl.module.document.repository.DocRepository;
import com.xjl.tl.module.document.service.DocSseHub.Push;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 失联任务检测（design D7）：运行中（PENDING / PARSING / ANALYZING / TRANSLATING / CONSISTENCY）的任务超过
 * {@code app.doc.stale-timeout}（默认 30 分钟）没有任何事件，标记为 FAILED（C0150，可重试）；
 * 停留在 CANCELLING 超时的任务（执行端不在线，无法回报 cancelled）直接置为 CANCELLED。
 * 计时起点为最近一次事件时间，没有事件时为创建 / 继续 / 确认术语的时间。
 */
@Component
public class DocStaleTaskDetector {

    private static final Logger log = LoggerFactory.getLogger(DocStaleTaskDetector.class);

    private final DocRepository repo;
    private final DocSseHub hub;
    private final DocProperties props;

    public DocStaleTaskDetector(DocRepository repo, DocSseHub hub, DocProperties props) {
        this.repo = repo;
        this.hub = hub;
        this.props = props;
    }

    @Scheduled(initialDelayString = "${app.doc.stale-check-interval-ms:60000}",
            fixedDelayString = "${app.doc.stale-check-interval-ms:60000}")
    void scheduled() {
        try {
            detect(props.staleTimeout());
        } catch (RuntimeException e) {
            log.warn("失联任务检测失败：{}", e.toString());
        }
    }

    /** 按给定阈值检测一次，返回被标记的任务数。 */
    public int detect(Duration threshold) {
        List<Push> pushes = mark(threshold);
        hub.publishAll(pushes);
        return pushes.size();
    }

    /** 每条 UPDATE 各自原子执行，无需额外事务。 */
    private List<Push> mark(Duration threshold) {
        OffsetDateTime cutoff = OffsetDateTime.now().minus(threshold);
        long minutes = Math.max(1, threshold.toMinutes());
        String message = "执行端超过 " + (threshold.toMinutes() >= 1 ? minutes + " 分钟" : threshold.toSeconds() + " 秒")
                + "没有上报进度，任务已中止，可点击继续";
        List<Push> pushes = new ArrayList<>();
        for (Long id : repo.markStale(DocStatus.RUNNING, DocStatus.FAILED, ErrorCode.DOC_TASK_FAILED.getCode(),
                message, true, cutoff)) {
            log.warn("文档任务失联，标记为 FAILED taskId={}", id);
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("code", ErrorCode.DOC_TASK_FAILED.getCode());
            data.put("message", message);
            data.put("retryable", true);
            pushes.add(new Push(id, "failed", data, true));
        }
        for (Long id : repo.markStale(List.of(DocStatus.CANCELLING), DocStatus.CANCELLED, null, null, false, cutoff)) {
            log.warn("取消中的文档任务长时间无回应，直接置为 CANCELLED taskId={}", id);
            pushes.add(new Push(id, "cancelled", Map.of(), true));
        }
        return pushes;
    }
}
