// 与 design.md D13 字段契约一一对应
export interface Result<T> {
  code: string;
  message: string;
  data: T;
  traceId?: string;
}

export interface PageResult<T> {
  records: T[];
  total: number;
  pageNum: number;
  pageSize: number;
}

export interface PageQuery {
  pageNum: number;
  pageSize: number;
}

export interface FieldError {
  field: string;
  message: string;
}

export type Role = "ADMIN" | "USER";
export type UserStatus = "ENABLED" | "DISABLED";

export interface UserInfo {
  id: number;
  username: string;
  nickname: string | null;
  email: string | null;
  status: UserStatus;
  roles: Role[];
  lastLoginAt: string | null;
  createdAt: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  /** 秒 */
  expiresIn: number;
  user: UserInfo;
}

export type Provider = "OPENAI_COMPATIBLE" | "ANTHROPIC" | "DASHSCOPE" | "VOLCENGINE" | "GOOGLE";

/** 能力类型（add-speech-and-image-translation，design D12） */
export type ModelCapability = "CHAT" | "ASR" | "TTS" | "REALTIME_TRANSLATE" | "REALTIME_CHAT" | "IMAGE_TRANSLATE";

export interface ModelParams {
  temperature?: number;
  maxTokens?: number;
  timeoutSeconds?: number;
  maxRetries?: number;
  /** 引擎相关的额外参数（非敏感），如 voice=Tina、appId */
  extra?: Record<string, string>;
}

export interface ModelConfigVO {
  id: number;
  name: string;
  /** 能力类型（旧后端缺失时按 CHAT 处理） */
  capability?: ModelCapability;
  provider: Provider;
  /** 是否支持图片输入（仅 CHAT 有意义） */
  supportsVision?: boolean;
  baseUrl: string;
  modelName: string;
  apiKeyMask: string;
  params: ModelParams;
  isDefault: boolean;
  /** 是否为评审模型（全局最多一个；旧后端没有该字段时按 false 处理） */
  isReviewDefault?: boolean;
  enabled: boolean;
  remark: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelConfigSaveRequest {
  name: string;
  /** 缺省为 CHAT */
  capability?: ModelCapability;
  provider: Provider;
  /** 仅 CHAT 有效，默认 false */
  supportsVision?: boolean;
  baseUrl: string;
  modelName: string;
  /** 更新时为空或缺省表示保持原值 */
  apiKey?: string;
  params?: ModelParams;
  remark?: string;
  enabled?: boolean;
}

export interface ModelTestResult {
  ok: boolean;
  model?: string;
  latencyMs: number;
  reply?: string;
  usage?: { promptTokens: number; completionTokens: number };
  errorCode?: string;
  errorMessage?: string;
}

export interface LoginLogVO {
  id: number;
  userId: number | null;
  username: string;
  ip: string;
  userAgent: string;
  success: boolean;
  failReason: string | null;
  createdAt: string;
}

export interface OperationLogVO {
  id: number;
  userId: number | null;
  username: string;
  module: string;
  action: string;
  method: string;
  path: string;
  params: string | null;
  resultCode: string;
  durationMs: number;
  ip: string;
  traceId: string;
  createdAt: string;
}

export type ComponentName = "spring" | "postgres" | "redis" | "ai-service";

export interface SystemStatus {
  items: { name: ComponentName; status: "UP" | "DOWN"; detail?: string }[];
}
