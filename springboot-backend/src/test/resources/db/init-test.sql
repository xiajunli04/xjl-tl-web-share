-- 测试容器初始化（以超级用户执行），与 docker/postgres/init/01-roles.sh 保持一致
CREATE ROLE tl_app LOGIN PASSWORD 'tl_app_pwd';
CREATE ROLE tl_ai LOGIN PASSWORD 'tl_ai_pwd';
GRANT CONNECT, CREATE ON DATABASE xjl_tl TO tl_app;
GRANT CONNECT ON DATABASE xjl_tl TO tl_ai;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
