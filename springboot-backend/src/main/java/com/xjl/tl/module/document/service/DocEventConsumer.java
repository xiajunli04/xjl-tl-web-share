package com.xjl.tl.module.document.service;

import com.xjl.tl.common.TraceIdHolder;
import com.xjl.tl.module.document.DocProperties;
import com.xjl.tl.module.document.service.DocEventHandler.Outcome;
import com.xjl.tl.module.document.service.DocEventHandler.PoisonEventException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.SmartLifecycle;
import org.springframework.data.domain.Range;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.connection.stream.Consumer;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.connection.stream.PendingMessage;
import org.springframework.data.redis.connection.stream.PendingMessages;
import org.springframework.data.redis.connection.stream.ReadOffset;
import org.springframework.data.redis.connection.stream.RecordId;
import org.springframework.data.redis.connection.stream.StreamOffset;
import org.springframework.data.redis.connection.stream.StreamReadOptions;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.stream.StreamMessageListenerContainer;
import org.springframework.data.redis.stream.StreamMessageListenerContainer.StreamMessageListenerContainerOptions;
import org.springframework.data.redis.stream.StreamMessageListenerContainer.StreamReadRequest;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 事件流 tl:doc-events 的消费者（消费组 spring，design D1 / D2 / D6）。
 * <ul>
 *   <li>启动时幂等创建消费组（XGROUP CREATE ... MKSTREAM，BUSYGROUP 忽略），同时为任务流预建 ai-worker 消费组
 *       （起始 id 为 0，Python 晚于 Spring 启动时也不会漏掉已写入的命令）</li>
 *   <li>启动时先补处理本消费者名下未确认的消息（上次停机前已读取但未确认），再认领其他消费者闲置超过
 *       {@code claim-min-idle}（默认 60 秒）的 pending 消息；之后按 {@code claim-interval-ms} 周期性认领</li>
 *   <li>实时消息由 {@link StreamMessageListenerContainer} 以 XREADGROUP &gt; 读取，关闭自动确认</li>
 *   <li>每条消息：落库成功（事务提交）后才 XACK，再推送给浏览器；无法解析的消息直接确认并丢弃；
 *       被删除或不存在的任务的事件确认并忽略；数据库异常时重试 3 次，仍失败则不确认，留待认领重试</li>
 *   <li>实时读取与认领串行处理（同一把锁），保证同一任务的事件按流顺序落库</li>
 * </ul>
 */
@Component
public class DocEventConsumer implements SmartLifecycle {

    private static final Logger log = LoggerFactory.getLogger(DocEventConsumer.class);
    private static final int MAX_ATTEMPTS = 3;

    private final DocProperties props;
    private final StringRedisTemplate redis;
    private final RedisConnectionFactory connectionFactory;
    private final DocEventHandler handler;
    private final DocSseHub hub;
    private final String consumerName;
    private final ReentrantLock processLock = new ReentrantLock();

    private volatile StreamMessageListenerContainer<String, MapRecord<String, String, String>> container;
    private volatile boolean running;

    public DocEventConsumer(DocProperties props, StringRedisTemplate redis, RedisConnectionFactory connectionFactory,
                            DocEventHandler handler, DocSseHub hub) {
        this.props = props;
        this.redis = redis;
        this.connectionFactory = connectionFactory;
        this.handler = handler;
        this.hub = hub;
        this.consumerName = StringUtils.hasText(props.consumerName()) ? props.consumerName() : defaultConsumerName();
    }

    // ---------------- 生命周期 ----------------

    @Override
    public synchronized void start() {
        if (running || !props.consumerEnabled()) {
            return;
        }
        running = true;
        try {
            ensureGroups();
            // 先把其他消费者闲置的消息转到本消费者名下，再按消息 id 顺序统一补处理，保证同一任务的事件按序落库
            claimIdle(false);
            recoverOwnPending();
        } catch (RuntimeException e) {
            // Redis 暂不可用时不阻止应用启动，周期性认领与容器错误处理会继续重试
            log.warn("文档事件消费者启动时补处理失败：{}", e.toString());
        }
        StreamMessageListenerContainerOptions<String, MapRecord<String, String, String>> options =
                StreamMessageListenerContainerOptions.builder()
                        .pollTimeout(props.pollTimeout())
                        .batchSize(props.batchSize())
                        .build();
        StreamMessageListenerContainer<String, MapRecord<String, String, String>> c =
                StreamMessageListenerContainer.create(connectionFactory, options);
        c.register(StreamReadRequest.builder(StreamOffset.create(props.eventsStream(), ReadOffset.lastConsumed()))
                .consumer(Consumer.from(props.springGroup(), consumerName))
                .autoAcknowledge(false)
                .cancelOnError(e -> false)
                .errorHandler(this::onReadError)
                .build(), this::onMessage);
        c.start();
        container = c;
        log.info("文档事件消费者已启动 stream={} group={} consumer={}", props.eventsStream(), props.springGroup(),
                consumerName);
    }

    @Override
    public synchronized void stop() {
        if (!running) {
            return;
        }
        // 先置位：停止过程中已读到的消息不再处理（不确认），重启后作为本消费者的 pending 消息补处理
        running = false;
        StreamMessageListenerContainer<String, MapRecord<String, String, String>> c = container;
        container = null;
        if (c != null) {
            c.stop();
        }
        log.info("文档事件消费者已停止 consumer={}", consumerName);
    }

    @Override
    public boolean isRunning() {
        return running;
    }

    public String consumerName() {
        return consumerName;
    }

    // ---------------- 消费组 ----------------

    /** 幂等创建事件流的 spring 消费组与任务流的 ai-worker 消费组。 */
    public void ensureGroups() {
        createGroup(props.eventsStream(), props.springGroup());
        createGroup(props.tasksStream(), props.workerGroup());
    }

    private void createGroup(String stream, String group) {
        try {
            redis.execute((org.springframework.data.redis.core.RedisCallback<Object>) conn ->
                    conn.streamCommands().xGroupCreate(stream.getBytes(StandardCharsets.UTF_8), group,
                            ReadOffset.from("0"), true));
            log.info("已创建消费组 stream={} group={}", stream, group);
        } catch (RuntimeException e) {
            if (!messageContains(e, "BUSYGROUP")) {
                throw e;
            }
        }
    }

    private void onReadError(Throwable e) {
        if (!running) {
            return;
        }
        if (messageContains(e, "NOGROUP")) {
            log.warn("事件流或消费组不存在，重新创建：{}", e.getMessage());
            try {
                ensureGroups();
            } catch (RuntimeException ex) {
                log.warn("重新创建消费组失败：{}", ex.toString());
            }
        } else {
            log.warn("读取事件流失败：{}", e.toString());
        }
        sleep(500);
    }

    // ---------------- 处理 ----------------

    private void onMessage(MapRecord<String, String, String> record) {
        if (!running) {
            return;
        }
        process(record);
    }

    /** 处理一条消息；返回是否已确认。 */
    boolean process(MapRecord<String, String, String> record) {
        processLock.lock();
        String previous = TraceIdHolder.get();
        try {
            String traceId = record.getValue().get("traceId");
            if (traceId != null) {
                TraceIdHolder.set(traceId);
            }
            for (int attempt = 1; ; attempt++) {
                try {
                    Outcome outcome = handler.handle(record.getValue());
                    ack(record.getId());
                    if (outcome.applied()) {
                        hub.publishAll(outcome.pushes());
                    } else {
                        log.debug("忽略文档事件 id={} taskId={}：{}", record.getId(), record.getValue().get("taskId"),
                                outcome.reason());
                    }
                    return true;
                } catch (PoisonEventException e) {
                    log.warn("丢弃无法处理的文档事件 id={} fields={}：{}", record.getId(), record.getValue().keySet(),
                            e.getMessage());
                    ack(record.getId());
                    return true;
                } catch (RuntimeException e) {
                    if (attempt >= MAX_ATTEMPTS) {
                        log.error("文档事件落库失败，暂不确认，等待认领重试 id={} taskId={}", record.getId(),
                                record.getValue().get("taskId"), e);
                        return false;
                    }
                    sleep(200L * attempt);
                }
            }
        } finally {
            if (previous != null) {
                TraceIdHolder.set(previous);
            } else {
                TraceIdHolder.clear();
            }
            processLock.unlock();
        }
    }

    private void ack(RecordId id) {
        redis.opsForStream().acknowledge(props.eventsStream(), props.springGroup(), id);
    }

    // ---------------- 补处理与认领 ----------------

    /** 本消费者名下已读取但未确认的消息（例如上次在落库后、确认前停机）。 */
    void recoverOwnPending() {
        String offset = "0";
        while (true) {
            List<MapRecord<String, String, String>> records = redis.<String, String>opsForStream().read(
                    Consumer.from(props.springGroup(), consumerName),
                    StreamReadOptions.empty().count(props.batchSize()),
                    StreamOffset.create(props.eventsStream(), ReadOffset.from(offset)));
            if (records == null || records.isEmpty()) {
                return;
            }
            for (MapRecord<String, String, String> r : records) {
                process(r);
                offset = r.getId().getValue();
            }
        }
    }

    /** 认领闲置超过 claim-min-idle 的 pending 消息（包括已停机的其他实例）；process=true 时随即处理。 */
    public void claimIdle(boolean process) {
        PendingMessages pending = redis.opsForStream().pending(props.eventsStream(), props.springGroup(),
                Range.unbounded(), 100, props.claimMinIdle());
        if (pending == null || pending.isEmpty()) {
            return;
        }
        RecordId[] ids = pending.stream().map(PendingMessage::getId).toArray(RecordId[]::new);
        List<MapRecord<String, String, String>> claimed = redis.<String, String>opsForStream().claim(props.eventsStream(),
                props.springGroup(), consumerName, props.claimMinIdle(), ids);
        if (claimed == null || claimed.isEmpty() || !process) {
            return;
        }
        log.info("认领 {} 条闲置的文档事件", claimed.size());
        for (MapRecord<String, String, String> r : claimed) {
            process(r);
        }
    }

    @Scheduled(initialDelayString = "${app.doc.claim-interval-ms:30000}", fixedDelayString = "${app.doc.claim-interval-ms:30000}")
    void scheduledClaim() {
        if (!running) {
            return;
        }
        try {
            claimIdle(true);
        } catch (RuntimeException e) {
            log.warn("周期性认领文档事件失败：{}", e.toString());
        }
    }

    // ---------------- 工具 ----------------

    private static boolean messageContains(Throwable e, String token) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t.getMessage() != null && t.getMessage().contains(token)) {
                return true;
            }
        }
        return false;
    }

    private static String defaultConsumerName() {
        try {
            return "spring-" + InetAddress.getLocalHost().getHostName();
        } catch (Exception e) {
            return "spring-1";
        }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
