package com.xjl.tl.module.user.service;

import com.xjl.tl.common.config.AppProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

import java.util.List;

/**
 * 初始管理员引导：没有 ADMIN 用户时，按环境变量 ADMIN_USERNAME / ADMIN_PASSWORD 创建。
 */
@Component
public class AdminBootstrapRunner implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(AdminBootstrapRunner.class);

    private final UserService userService;
    private final AppProperties props;

    public AdminBootstrapRunner(UserService userService, AppProperties props) {
        this.userService = userService;
        this.props = props;
    }

    @Override
    public void run(ApplicationArguments args) {
        bootstrap();
    }

    /** @return 是否创建了管理员 */
    public boolean bootstrap() {
        if (userService.existsAdmin()) {
            log.debug("已存在管理员，跳过初始化");
            return false;
        }
        AppProperties.Admin admin = props.admin();
        if (admin == null || !StringUtils.hasText(admin.username()) || !StringUtils.hasText(admin.password())) {
            log.warn("数据库中没有管理员，且未配置 ADMIN_USERNAME / ADMIN_PASSWORD，跳过创建初始管理员");
            return false;
        }
        if (userService.findByUsername(admin.username()) != null) {
            log.warn("用户名 {} 已被普通用户占用，无法创建初始管理员", admin.username());
            return false;
        }
        userService.create(admin.username(), admin.password(), "管理员", null,
                List.of(UserService.ROLE_ADMIN, UserService.ROLE_USER));
        log.info("已创建初始管理员 {}", admin.username());
        return true;
    }
}
