package com.xjl.tl.module.document.service;

import com.xjl.tl.module.document.DocProperties;
import com.xjl.tl.module.document.dto.DocDtos.TaskPayload;
import com.xjl.tl.module.document.dto.DocDtos.TermPair;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.connection.stream.RecordId;
import org.springframework.data.redis.connection.stream.StreamRecords;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 向任务流 tl:doc-tasks 写入命令（design D2，样例见 docs/contracts/doc-stream-sample.md 第 1 节）。
 * <p>
 * 所有字段值都是字符串：taskId 为数字字符串，payload / data 为单行 JSON（Jackson 默认紧凑输出，不含换行）。
 */
@Component
public class DocCommandPublisher {

    public static final String CMD_START = "start";
    public static final String CMD_RESUME = "resume";
    public static final String CMD_RETRY = "retry";
    public static final String CMD_CANCEL = "cancel";

    private static final Logger log = LoggerFactory.getLogger(DocCommandPublisher.class);

    private final StringRedisTemplate redis;
    private final JsonMapper jsonMapper;
    private final DocProperties props;

    public DocCommandPublisher(StringRedisTemplate redis, JsonMapper jsonMapper, DocProperties props) {
        this.redis = redis;
        this.jsonMapper = jsonMapper;
        this.props = props;
    }

    /** {cmd:start, taskId, traceId, payload}。 */
    public RecordId start(long taskId, String traceId, TaskPayload payload) {
        return send(CMD_START, taskId, traceId, "payload", jsonMapper.writeValueAsString(payload));
    }

    /** {cmd:retry, taskId, traceId, payload}：payload 与 start 相同，防止检查点丢失时无法重建。 */
    public RecordId retry(long taskId, String traceId, TaskPayload payload) {
        return send(CMD_RETRY, taskId, traceId, "payload", jsonMapper.writeValueAsString(payload));
    }

    /** {cmd:resume, taskId, traceId, data:{terms:[{source,target}]}}。 */
    public RecordId resume(long taskId, String traceId, List<TermPair> terms) {
        return send(CMD_RESUME, taskId, traceId, "data", jsonMapper.writeValueAsString(Map.of("terms", terms)));
    }

    /** {cmd:cancel, taskId}：用户取消，执行端保留检查点，之后可以 retry 续译。 */
    public RecordId cancel(long taskId) {
        return send(CMD_CANCEL, taskId, null, null, null);
    }

    /** {cmd:cancel, taskId, purge:"true"}：删除任务，执行端取消后立即清理检查点、分块缓存与 eventSeq 计数。 */
    public RecordId cancelAndPurge(long taskId) {
        return send(CMD_CANCEL, taskId, null, "purge", "true");
    }

    private RecordId send(String cmd, long taskId, String traceId, String extraKey, String extraValue) {
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("cmd", cmd);
        fields.put("taskId", String.valueOf(taskId));
        if (traceId != null) {
            fields.put("traceId", traceId);
        }
        if (extraKey != null) {
            fields.put(extraKey, extraValue);
        }
        MapRecord<String, String, String> record = StreamRecords.newRecord().in(props.tasksStream()).ofMap(fields);
        RecordId id = redis.opsForStream().add(record);
        log.info("写入任务流 cmd={} taskId={} traceId={} id={}", cmd, taskId, traceId, id);
        return id;
    }
}
