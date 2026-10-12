import { http } from "@/lib/http";
import type { LoginLogVO, OperationLogVO, PageQuery, PageResult, SystemStatus } from "./types";

export interface LoginLogQuery extends PageQuery {
  username?: string;
  success?: boolean;
  startTime?: string;
  endTime?: string;
}

export interface OperationLogQuery extends PageQuery {
  username?: string;
  module?: string;
  startTime?: string;
  endTime?: string;
}

export const logApi = {
  login: (q: LoginLogQuery) => http.get<PageResult<LoginLogVO>>("/api/admin/logs/login", { ...q }),
  operation: (q: OperationLogQuery) =>
    http.get<PageResult<OperationLogVO>>("/api/admin/logs/operation", { ...q }),
};

export const systemApi = {
  status: () => http.get<SystemStatus>("/api/admin/system/status"),
};
