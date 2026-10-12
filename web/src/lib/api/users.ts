import { http } from "@/lib/http";
import type { PageQuery, PageResult, Role, UserInfo, UserStatus } from "./types";

export interface UserQuery extends PageQuery {
  username?: string;
  status?: UserStatus;
  role?: Role;
}

export interface CreateUserRequest {
  username: string;
  password: string;
  nickname?: string;
  email?: string;
  roles: Role[];
}

export const userApi = {
  updateMe: (body: { nickname?: string; email?: string }) =>
    http.put<UserInfo>("/api/users/me", body),
  changePassword: (body: { oldPassword: string; newPassword: string }) =>
    http.put<null>("/api/users/me/password", body),
};

export const adminUserApi = {
  page: (q: UserQuery) => http.get<PageResult<UserInfo>>("/api/admin/users", { ...q }),
  create: (body: CreateUserRequest) => http.post<UserInfo>("/api/admin/users", body),
  setStatus: (id: number, status: UserStatus) =>
    http.put<null>(`/api/admin/users/${id}/status`, { status }),
  setRoles: (id: number, roles: Role[]) =>
    http.put<null>(`/api/admin/users/${id}/roles`, { roles }),
  resetPassword: (id: number, password: string) =>
    http.put<null>(`/api/admin/users/${id}/password`, { password }),
  remove: (id: number) => http.del<null>(`/api/admin/users/${id}`),
};
