package com.xjl.tl.infra.storage;

import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.config.MediaProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.LocalDate;
import java.util.Arrays;
import java.util.Objects;
import java.util.UUID;

/**
 * 本地文件存储（add-speech-and-image-translation D10）：文件位于 app.media.storage-dir 下，
 * 路径为 {category}/yyyy/MM/{uuid}.{ext}，数据库只保存相对路径。
 * 访问控制由业务层按记录归属完成；删除记录时异步删文件，失败只记日志。
 */
@Component
public class MediaStorage {

    private static final Logger log = LoggerFactory.getLogger(MediaStorage.class);

    private final Path root;

    public MediaStorage(MediaProperties props) {
        this.root = Path.of(props.storageDir()).toAbsolutePath().normalize();
        log.info("媒体文件存储目录：{}", root);
    }

    /** 保存文件并返回相对路径（先写临时文件再原子移动，避免读到半个文件）。 */
    public String save(String category, String ext, byte[] data) {
        LocalDate today = LocalDate.now();
        String rel = String.format("%s/%04d/%02d/%s.%s", category, today.getYear(), today.getMonthValue(),
                UUID.randomUUID(), ext);
        Path target = resolve(rel);
        try {
            Files.createDirectories(target.getParent());
            Path tmp = Files.createTempFile(target.getParent(), ".upload-", ".tmp");
            Files.write(tmp, data);
            Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            log.error("保存文件失败 {}", target, e);
            throw new BizException(ErrorCode.SYSTEM_ERROR, "文件保存失败");
        }
        return rel;
    }

    /** 读取文件；文件不存在返回 null。 */
    public byte[] read(String rel) {
        try {
            return Files.readAllBytes(resolve(rel));
        } catch (NoSuchFileException e) {
            return null;
        } catch (IOException e) {
            log.error("读取文件失败 {}", rel, e);
            throw new BizException(ErrorCode.SYSTEM_ERROR, "文件读取失败");
        }
    }

    /** 相对路径 → 绝对路径；拒绝越出存储根目录的路径。 */
    public Path resolve(String rel) {
        Path p = root.resolve(rel).normalize();
        if (!p.startsWith(root)) {
            throw new IllegalArgumentException("非法的存储路径：" + rel);
        }
        return p;
    }

    /** 删除文件（忽略 null 与不存在的文件，失败只记日志）。 */
    public void delete(String rel) {
        if (rel == null) {
            return;
        }
        try {
            Files.deleteIfExists(resolve(rel));
        } catch (IOException | RuntimeException e) {
            log.warn("删除文件失败 {}：{}", rel, e.toString());
        }
    }

    /** 在虚拟线程中异步删除文件。 */
    public void deleteAsync(String... rels) {
        String[] targets = Arrays.stream(rels).filter(Objects::nonNull).toArray(String[]::new);
        if (targets.length == 0) {
            return;
        }
        Thread.ofVirtual().name("media-delete").start(() -> {
            for (String rel : targets) {
                delete(rel);
            }
        });
    }
}
