"use client";

import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { AnimatePresence, motion } from "motion/react";
import {
  ChevronRightIcon,
  KeyRoundIcon,
  ShieldCheckIcon,
  ShieldIcon,
  Trash2Icon,
  UserCheckIcon,
  UserIcon,
  UserPlusIcon,
  UserXIcon,
  UsersIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmDialog, Field, FilterChip, PageContainer, PageHeader, Pagination, Surface } from "@/components/layout/common";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import { TableSkeleton } from "@/components/feedback/skeletons";
import { StaggerRow } from "@/components/motion/stagger";
import { DURATION } from "@/components/motion/tokens";
import { FilterField, FilterPopover } from "@/components/admin/filter-popover";
import { SearchInput } from "@/components/admin/search-input";
import { adminUserApi, type UserQuery } from "@/lib/api/users";
import type { Role, UserInfo, UserStatus } from "@/lib/api/types";
import { toastError } from "@/lib/errors";
import { formatTime, optionalEmail, passwordSchema, usernameSchema } from "@/lib/validators";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";

const ROLES: { value: Role; label: string }[] = [
  { value: "ADMIN", label: "管理员" },
  { value: "USER", label: "普通用户" },
];
const roleLabel = (r: Role) => ROLES.find((x) => x.value === r)?.label ?? r;

function RolePicker({ value, onChange }: { value: Role[]; onChange: (v: Role[]) => void }) {
  return (
    <div className="flex gap-4">
      {ROLES.map((r) => (
        <label key={r.value} className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={value.includes(r.value)}
            onCheckedChange={(c) => onChange(c ? [...value, r.value] : value.filter((x) => x !== r.value))}
          />
          {r.label}
        </label>
      ))}
    </div>
  );
}

/** 状态徽标：布局动画 + 颜色过渡（150ms） */
function StatusBadge({ status }: { status: UserStatus }) {
  const on = status === "ENABLED";
  return (
    <motion.span
      layout
      transition={{ duration: DURATION.fast }}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium transition-colors duration-150",
        on ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
      )}
    >
      <span className={cn("size-1.5 rounded-full transition-colors duration-150", on ? "bg-success" : "bg-danger")} />
      <AnimatePresence mode="wait" initial={false}>
        <motion.span key={status} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: DURATION.fast }}>
          {on ? "启用" : "禁用"}
        </motion.span>
      </AnimatePresence>
    </motion.span>
  );
}

function Avatar({ u, size = "md" }: { u: UserInfo; size?: "md" | "lg" }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-brand-soft font-semibold text-brand",
        size === "lg" ? "size-12 text-lg" : "size-8 text-xs",
      )}
    >
      {(u.nickname || u.username).slice(0, 1).toUpperCase()}
    </span>
  );
}

const createSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  nickname: z.string().max(32, "昵称最多 32 个字符"),
  email: optionalEmail,
  roles: z.array(z.enum(["ADMIN", "USER"])).min(1, "至少选择一个角色"),
});
type CreateValues = z.infer<typeof createSchema>;

function CreateUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const form = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { username: "", password: "", nickname: "", email: "", roles: ["USER"] },
  });
  const e = form.formState.errors;
  const roles = useWatch({ control: form.control, name: "roles" });

  const submit = async (v: CreateValues) => {
    try {
      await adminUserApi.create({
        username: v.username,
        password: v.password,
        nickname: v.nickname || undefined,
        email: v.email || undefined,
        roles: v.roles,
      });
      toast.success("用户已创建");
      form.reset();
      onOpenChange(false);
      qc.invalidateQueries({ queryKey: ["admin-users"] });
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建用户</DialogTitle>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={form.handleSubmit(submit)} noValidate>
          <div className="grid grid-cols-2 gap-3">
            <Field label="用户名" htmlFor="c-username" error={e.username?.message}>
              <Input id="c-username" {...form.register("username")} />
            </Field>
            <Field label="初始密码" htmlFor="c-password" error={e.password?.message}>
              <Input id="c-password" type="password" autoComplete="new-password" {...form.register("password")} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="昵称" htmlFor="c-nickname" error={e.nickname?.message}>
              <Input id="c-nickname" {...form.register("nickname")} />
            </Field>
            <Field label="邮箱" htmlFor="c-email" error={e.email?.message}>
              <Input id="c-email" type="email" {...form.register("email")} />
            </Field>
          </div>
          <Field label="角色" error={e.roles?.message}>
            <RolePicker value={roles} onChange={(v) => form.setValue("roles", v, { shouldValidate: true })} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              创建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Section({ icon: Icon, title, desc, children }: { icon: typeof UserIcon; title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-4 shadow-card">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="size-4 text-brand" />
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      {desc && <p className="-mt-2 mb-3 text-xs text-muted-foreground">{desc}</p>}
      {children}
    </section>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate">{children}</span>
    </div>
  );
}

/** 用户详情侧滑：基本信息 / 角色 / 安全操作 */
function UserSheet({
  user,
  onClose,
  onDisable,
  onEnable,
  onDelete,
  enabling,
}: {
  user: UserInfo | null;
  onClose: () => void;
  onDisable: (u: UserInfo) => void;
  onEnable: (u: UserInfo) => void;
  onDelete: (u: UserInfo) => void;
  enabling: boolean;
}) {
  return (
    <Sheet open={!!user} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-md">
        {user && <UserSheetBody key={user.id} user={user} onDisable={onDisable} onEnable={onEnable} onDelete={onDelete} enabling={enabling} />}
      </SheetContent>
    </Sheet>
  );
}

function UserSheetBody({
  user,
  onDisable,
  onEnable,
  onDelete,
  enabling,
}: {
  user: UserInfo;
  onDisable: (u: UserInfo) => void;
  onEnable: (u: UserInfo) => void;
  onDelete: (u: UserInfo) => void;
  enabling: boolean;
}) {
  const qc = useQueryClient();
  const me = useAuthStore((s) => s.user);
  const self = me?.id === user.id;
  const [roles, setRoles] = useState<Role[]>(user.roles);
  const [password, setPassword] = useState("");
  const [pwdError, setPwdError] = useState<string>();
  const rolesChanged = roles.slice().sort().join() !== user.roles.slice().sort().join();

  const rolesM = useMutation({
    mutationFn: () => adminUserApi.setRoles(user.id, roles),
    onSuccess: () => {
      toast.success("角色已更新，该用户需重新登录");
      qc.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: toastError,
  });
  const pwdM = useMutation({
    mutationFn: () => adminUserApi.resetPassword(user.id, password),
    onSuccess: () => {
      toast.success("密码已重置，该用户需重新登录");
      setPassword("");
    },
    onError: toastError,
  });
  const resetPwd = () => {
    const r = passwordSchema.safeParse(password);
    if (!r.success) return setPwdError(r.error.issues[0]?.message);
    setPwdError(undefined);
    pwdM.mutate();
  };

  return (
    <>
      <SheetHeader>
        <div className="flex items-center gap-3">
          <Avatar u={user} size="lg" />
          <div className="min-w-0">
            <SheetTitle className="flex items-center gap-2">
              {user.nickname || user.username}
              <StatusBadge status={user.status} />
            </SheetTitle>
            <SheetDescription>@{user.username}</SheetDescription>
          </div>
        </div>
      </SheetHeader>
      <SheetBody className="space-y-4">
        <Section icon={UserIcon} title="基本信息">
          <div className="divide-y">
            <InfoRow label="用户 ID">{user.id}</InfoRow>
            <InfoRow label="昵称">{user.nickname || "—"}</InfoRow>
            <InfoRow label="邮箱">{user.email || "—"}</InfoRow>
            <InfoRow label="最近登录">{formatTime(user.lastLoginAt)}</InfoRow>
            <InfoRow label="创建时间">{formatTime(user.createdAt)}</InfoRow>
          </div>
        </Section>
        <Section icon={ShieldCheckIcon} title="角色" desc="修改角色后该用户的现有会话将失效。">
          <RolePicker value={roles} onChange={setRoles} />
          <div className="mt-3 flex justify-end">
            <Button size="sm" disabled={!roles.length || !rolesChanged || rolesM.isPending} onClick={() => rolesM.mutate()}>
              保存角色
            </Button>
          </div>
        </Section>
        <Section icon={KeyRoundIcon} title="安全操作">
          <div className="space-y-4">
            <Field label="重置密码" htmlFor="r-password" error={pwdError} hint="8–64 位，需同时包含字母和数字">
              <div className="flex gap-2">
                <Input
                  id="r-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <Button variant="outline" disabled={!password || pwdM.isPending} onClick={resetPwd}>
                  重置
                </Button>
              </div>
            </Field>
            <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div>
                <div className="text-sm font-medium">{user.status === "ENABLED" ? "禁用账号" : "启用账号"}</div>
                <div className="text-xs text-muted-foreground">
                  {user.status === "ENABLED" ? "禁用后该用户将被立即强制下线" : "恢复该用户的登录权限"}
                </div>
              </div>
              {user.status === "ENABLED" ? (
                <Button variant="outline" size="sm" disabled={self} onClick={() => onDisable(user)}>
                  <UserXIcon />
                  禁用
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled={enabling} onClick={() => onEnable(user)}>
                  <UserCheckIcon />
                  启用
                </Button>
              )}
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger-soft p-3">
              <div>
                <div className="text-sm font-medium text-danger">删除用户</div>
                <div className="text-xs text-muted-foreground">此操作不可恢复</div>
              </div>
              <Button variant="destructive" size="sm" disabled={self} onClick={() => onDelete(user)}>
                <Trash2Icon />
                删除
              </Button>
            </div>
            {self && <p className="text-xs text-muted-foreground">不能禁用或删除当前登录的账号。</p>}
          </div>
        </Section>
      </SheetBody>
    </>
  );
}

type Pending = { kind: "delete" | "disable"; user: UserInfo } | null;
const EMPTY_F = { status: "" as "" | UserStatus, role: "" as "" | Role };

export default function UsersPage() {
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [filters, setFilters] = useState(EMPTY_F);
  const [draft, setDraft] = useState(EMPTY_F);
  const [query, setQuery] = useState<UserQuery>({ pageNum: 1, pageSize: 10 });
  const [createOpen, setCreateOpen] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [openId, setOpenId] = useState<number | null>(null);

  const list = useQuery({
    queryKey: ["admin-users", query],
    queryFn: () => adminUserApi.page(query),
    placeholderData: keepPreviousData,
  });
  const records = list.data?.records ?? [];
  const opened = records.find((u) => u.id === openId) ?? null;

  const invalidate = () => qc.invalidateQueries({ queryKey: ["admin-users"] });

  const statusM = useMutation({
    mutationFn: (p: { id: number; status: UserStatus }) => adminUserApi.setStatus(p.id, p.status),
    onSuccess: (_d, p) => {
      toast.success(p.status === "ENABLED" ? "已启用" : "已禁用，该用户已被强制下线");
      setPending(null);
      invalidate();
    },
    onError: toastError,
  });
  const deleteM = useMutation({
    mutationFn: (id: number) => adminUserApi.remove(id),
    onSuccess: () => {
      toast.success("用户已删除");
      setPending(null);
      setOpenId(null);
      invalidate();
    },
    onError: toastError,
  });

  const apply = (f: typeof EMPTY_F) => {
    setFilters(f);
    setQuery({
      pageNum: 1,
      pageSize: query.pageSize,
      username: username.trim() || undefined,
      status: f.status || undefined,
      role: f.role || undefined,
    });
  };

  const chips: { key: keyof typeof EMPTY_F; label: string }[] = [];
  if (filters.status) chips.push({ key: "status", label: filters.status === "ENABLED" ? "状态：启用" : "状态：禁用" });
  if (filters.role) chips.push({ key: "role", label: `角色：${roleLabel(filters.role)}` });

  return (
    <PageContainer>
      <PageHeader
        title="用户管理"
        description="管理平台用户账号、状态与角色"
        icon={UsersIcon}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <UserPlusIcon />
            新建用户
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SearchInput value={username} onChange={setUsername} onSubmit={() => apply(filters)} placeholder="按用户名模糊搜索，回车确认" />
        <FilterPopover count={chips.length} onOpen={() => setDraft(filters)} onClear={() => setDraft(EMPTY_F)} onApply={() => apply(draft)}>
          <FilterField label="状态">
            <Segmented<"" | UserStatus>
              size="sm"
              className="w-full"
              value={draft.status}
              onChange={(v) => setDraft({ ...draft, status: v })}
              options={[
                { value: "", label: "全部" },
                { value: "ENABLED", label: "启用" },
                { value: "DISABLED", label: "禁用" },
              ]}
            />
          </FilterField>
          <FilterField label="角色">
            <Segmented<"" | Role>
              size="sm"
              className="w-full"
              value={draft.role}
              onChange={(v) => setDraft({ ...draft, role: v })}
              options={[{ value: "", label: "全部" }, ...ROLES]}
            />
          </FilterField>
        </FilterPopover>
        <AnimatePresence>
          {chips.map((c) => (
            <FilterChip key={c.key} label={c.label} onRemove={() => apply({ ...filters, [c.key]: "" })} />
          ))}
        </AnimatePresence>
      </div>

      <Surface>
        {list.isLoading ? (
          <TableSkeleton rows={8} cols={5} />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} retrying={list.isFetching} />
        ) : !records.length ? (
          <EmptyState compact icon={UsersIcon} title="没有符合条件的用户" description="调整搜索或筛选条件后再试。" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead className="pl-4">用户</TableHead>
                <TableHead>邮箱</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>最近登录</TableHead>
                <TableHead className="w-10 pr-4" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((u, i) => (
                <StaggerRow
                  key={u.id}
                  index={i}
                  onClick={() => setOpenId(u.id)}
                  className="group cursor-pointer border-b transition-colors hover:bg-muted/40"
                >
                  <TableCell className="pl-4">
                    <span className="flex items-center gap-3">
                      <Avatar u={u} />
                      <span className="min-w-0">
                        <span className="block font-medium">{u.nickname || u.username}</span>
                        <span className="block text-xs text-muted-foreground">@{u.username}</span>
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{u.email || "—"}</TableCell>
                  <TableCell>
                    <span className="flex gap-1">
                      {u.roles.map((r) => (
                        <span
                          key={r}
                          className={cn(
                            "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
                            r === "ADMIN" ? "bg-brand-soft text-brand" : "bg-muted text-muted-foreground",
                          )}
                        >
                          {r === "ADMIN" && <ShieldIcon className="size-3" />}
                          {roleLabel(r)}
                        </span>
                      ))}
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={u.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">{formatTime(u.lastLoginAt)}</TableCell>
                  <TableCell className="pr-4">
                    <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </TableCell>
                </StaggerRow>
              ))}
            </TableBody>
          </Table>
        )}
        {list.data && list.data.total > 0 && (
          <Pagination
            className="border-t px-4 py-2.5"
            pageNum={query.pageNum}
            pageSize={query.pageSize}
            total={list.data.total}
            onChange={(p) => setQuery({ ...query, pageNum: p })}
          />
        )}
      </Surface>

      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />
      <UserSheet
        user={opened}
        onClose={() => setOpenId(null)}
        enabling={statusM.isPending}
        onEnable={(u) => statusM.mutate({ id: u.id, status: "ENABLED" })}
        onDisable={(u) => setPending({ kind: "disable", user: u })}
        onDelete={(u) => setPending({ kind: "delete", user: u })}
      />
      <ConfirmDialog
        open={pending?.kind === "disable"}
        onOpenChange={(o) => !o && setPending(null)}
        title="禁用用户"
        description={`确定禁用用户「${pending?.user.username}」吗？该用户将被立即强制下线。`}
        confirmText="禁用"
        pending={statusM.isPending}
        onConfirm={() => pending && statusM.mutate({ id: pending.user.id, status: "DISABLED" })}
      />
      <ConfirmDialog
        open={pending?.kind === "delete"}
        onOpenChange={(o) => !o && setPending(null)}
        title="删除用户"
        description={`确定删除用户「${pending?.user.username}」吗？此操作不可恢复。`}
        confirmText="删除"
        pending={deleteM.isPending}
        onConfirm={() => pending && deleteM.mutate(pending.user.id)}
      />
    </PageContainer>
  );
}
