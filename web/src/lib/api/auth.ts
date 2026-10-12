import { http } from "@/lib/http";
import type { LoginResult, UserInfo } from "./types";

export interface RegisterRequest {
  username: string;
  password: string;
  nickname?: string;
  email?: string;
}

export const authApi = {
  register: (body: RegisterRequest) => http.post<UserInfo>("/api/auth/register", body, true),
  login: (body: { username: string; password: string }) =>
    http.post<LoginResult>("/api/auth/login", body, true),
  refresh: (body: { refreshToken: string }) =>
    http.post<LoginResult>("/api/auth/refresh", body, true),
  logout: (body: { refreshToken?: string }) => http.post<null>("/api/auth/logout", body),
  me: () => http.get<UserInfo>("/api/auth/me"),
};
