package com.xjl.tl.module.document.service;

import com.xjl.tl.module.document.DocProperties;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * 文档任务进度的浏览器 SSE 推送中心（design D10 / D13）。
 * <ul>
 *   <li>每个订阅者一个 {@link SseEmitter} 与一条发送队列，由虚拟线程按顺序发送，慢客户端不阻塞事件消费</li>
 *   <li>订阅时先登记、再读取快照：登记之后产生的事件排在 snapshot 之后发送，保证先收到 snapshot</li>
 *   <li>每个心跳间隔向所有订阅者发送注释 {@code :ping}；发送失败（客户端断开）时注销</li>
 *   <li>终结事件（completed / failed / cancelled）发送后关闭连接</li>
 * </ul>
 * 用户隔离在订阅入口完成（只能订阅自己的任务），本类按 taskId 分发。
 */
@Component
public class DocSseHub {

    /** 一条待推送的事件：event 为事件名，data 为将被序列化为单行 JSON 的对象。 */
    public record Push(long taskId, String event, Object data, boolean terminal) {
    }

    private static final Logger log = LoggerFactory.getLogger(DocSseHub.class);
    /** data 按 UTF-8 写出（StringHttpMessageConverter 默认 ISO-8859-1）。 */
    private static final MediaType TEXT_UTF8 = new MediaType("text", "plain", StandardCharsets.UTF_8);

    private final JsonMapper jsonMapper;
    private final Map<Long, Set<Subscriber>> subscribers = new ConcurrentHashMap<>();
    private final ExecutorService sender = Executors.newVirtualThreadPerTaskExecutor();
    private final ScheduledExecutorService heartbeat;

    public DocSseHub(JsonMapper jsonMapper, DocProperties props) {
        this.jsonMapper = jsonMapper;
        this.heartbeat = Executors.newSingleThreadScheduledExecutor(
                Thread.ofPlatform().daemon().name("doc-sse-heartbeat").factory());
        long interval = props.heartbeatInterval().toMillis();
        heartbeat.scheduleAtFixedRate(this::ping, interval, interval, TimeUnit.MILLISECONDS);
    }

    /**
     * 登记一个订阅者。返回的订阅者在 {@link Subscriber#start(String, Object, boolean)} 之前只缓存事件、不发送。
     */
    public Subscriber register(long taskId, SseEmitter emitter) {
        Subscriber s = new Subscriber(taskId, emitter);
        subscribers.computeIfAbsent(taskId, k -> ConcurrentHashMap.newKeySet()).add(s);
        emitter.onCompletion(() -> unregister(s));
        emitter.onTimeout(() -> unregister(s));
        emitter.onError(e -> unregister(s));
        return s;
    }

    /** 推送一批事件（落库提交之后调用）。 */
    public void publishAll(List<Push> pushes) {
        pushes.forEach(this::publish);
    }

    public void publish(Push push) {
        Set<Subscriber> set = subscribers.get(push.taskId());
        if (set == null || set.isEmpty()) {
            return;
        }
        String data = jsonMapper.writeValueAsString(push.data());
        for (Subscriber s : set) {
            s.enqueue(new Outgoing(push.event(), data, push.terminal()));
        }
    }

    /** 关闭某任务的全部订阅（任务被删除）。 */
    public void closeAll(long taskId) {
        Set<Subscriber> set = subscribers.remove(taskId);
        if (set != null) {
            set.forEach(s -> s.enqueue(Outgoing.CLOSE));
        }
    }

    /** 当前订阅者数量（测试与排查用）。 */
    public int subscriberCount(long taskId) {
        Set<Subscriber> set = subscribers.get(taskId);
        return set == null ? 0 : set.size();
    }

    private void unregister(Subscriber s) {
        s.closed = true;
        subscribers.computeIfPresent(s.taskId, (k, set) -> {
            set.remove(s);
            return set.isEmpty() ? null : set;
        });
    }

    private void ping() {
        try {
            subscribers.values().forEach(set -> set.forEach(s -> s.enqueue(Outgoing.PING)));
        } catch (RuntimeException e) {
            log.warn("发送 SSE 心跳失败", e);
        }
    }

    @PreDestroy
    void shutdown() {
        heartbeat.shutdownNow();
        subscribers.values().forEach(set -> set.forEach(s -> s.enqueue(Outgoing.CLOSE)));
        sender.shutdown();
    }

    /** 发送队列中的一项；PING 为注释心跳，CLOSE 只关闭连接。 */
    private record Outgoing(String event, String data, boolean terminal) {
        static final Outgoing PING = new Outgoing(null, null, false);
        static final Outgoing CLOSE = new Outgoing(null, null, true);
    }

    /** 一个浏览器连接。 */
    public final class Subscriber {
        private final long taskId;
        private final SseEmitter emitter;
        private final Deque<Outgoing> queue = new ArrayDeque<>();
        private boolean started;
        private boolean draining;
        private volatile boolean closed;

        private Subscriber(long taskId, SseEmitter emitter) {
            this.taskId = taskId;
            this.emitter = emitter;
        }

        /** 放入 snapshot（排在已缓存事件之前）并开始发送；terminal=true 时发送 snapshot 后关闭。 */
        public void start(String event, Object data, boolean terminal) {
            Outgoing first = new Outgoing(event, jsonMapper.writeValueAsString(data), terminal);
            synchronized (this) {
                queue.addFirst(first);
                started = true;
            }
            if (terminal) {
                unregister(this);
            }
            schedule();
        }

        private void enqueue(Outgoing o) {
            if (closed) {
                return;
            }
            synchronized (this) {
                if (o == Outgoing.PING && (!started || !queue.isEmpty())) {
                    return;
                }
                queue.addLast(o);
            }
            schedule();
        }

        private void schedule() {
            synchronized (this) {
                if (!started || draining || queue.isEmpty()) {
                    return;
                }
                draining = true;
            }
            try {
                sender.execute(this::drain);
            } catch (RuntimeException e) {
                synchronized (this) {
                    draining = false;
                }
            }
        }

        private void drain() {
            while (true) {
                Outgoing o;
                synchronized (this) {
                    o = queue.pollFirst();
                    if (o == null) {
                        draining = false;
                        return;
                    }
                }
                if (closed && o != Outgoing.CLOSE && !o.terminal()) {
                    continue;
                }
                try {
                    if (o == Outgoing.PING) {
                        emitter.send(SseEmitter.event().comment("ping"));
                    } else if (o.event() != null) {
                        emitter.send(SseEmitter.event().name(o.event()).data(o.data(), TEXT_UTF8));
                    }
                    if (o.terminal()) {
                        closed = true;
                        unregister(this);
                        emitter.complete();
                        synchronized (this) {
                            queue.clear();
                            draining = false;
                        }
                        return;
                    }
                } catch (IOException | IllegalStateException e) {
                    // 客户端已断开或连接已结束
                    log.debug("SSE 发送失败，注销订阅 taskId={}：{}", taskId, e.toString());
                    closed = true;
                    unregister(this);
                    try {
                        emitter.completeWithError(e);
                    } catch (RuntimeException ignored) {
                        // 已结束
                    }
                    synchronized (this) {
                        queue.clear();
                        draining = false;
                    }
                    return;
                }
            }
        }
    }
}
