"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CameraOffIcon, Loader2Icon, SwitchCameraIcon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Facing = "environment" | "user";
type CamStatus = "starting" | "ready" | "denied" | "unavailable" | "error";

function describe(status: CamStatus) {
  switch (status) {
    case "denied":
      return { title: "无法使用摄像头：权限被拒绝", body: "请在浏览器地址栏的权限设置中允许访问摄像头后重试。你仍然可以上传、拖拽或粘贴图片。" };
    case "unavailable":
      return { title: "没有检测到可用的摄像头", body: "当前设备或浏览器不支持拍照（需要 HTTPS 或 localhost）。你仍然可以上传、拖拽或粘贴图片。" };
    default:
      return { title: "摄像头启动失败", body: "摄像头可能被其他应用占用，请关闭后重试，或改用上传图片。" };
  }
}

/**
 * 拍照弹窗：getUserMedia 取景，快门白闪 120 ms，可切换前后摄像头；
 * 权限被拒或无摄像头时给出提示并保留其他输入方式。
 */
export function CameraDialog({
  open,
  onOpenChange,
  onCapture,
  onUpload,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCapture: (file: File) => void;
  /** 无法拍照时改为上传 */
  onUpload: () => void;
}) {
  const reduce = useReducedMotion();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [facing, setFacing] = useState<Facing>("environment");
  const [cam, setCam] = useState<{ key: string; status: CamStatus }>({ key: "", status: "starting" });
  const [multiple, setMultiple] = useState(false);
  const [flash, setFlash] = useState(0);
  const [busy, setBusy] = useState(false);
  const key = `${open}-${facing}`;
  const status: CamStatus = cam.key === key ? cam.status : "starting";

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const k = `${open}-${facing}`;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        if (!cancelled) setCam({ key: k, status: "unavailable" });
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        if (!cancelled) {
          setMultiple(devices.filter((d) => d.kind === "videoinput").length > 1);
          setCam({ key: k, status: "ready" });
        }
      } catch (e) {
        if (cancelled) return;
        const name = e instanceof DOMException ? e.name : "";
        setCam({
          key: k,
          status: name === "NotAllowedError" || name === "SecurityError" ? "denied" : name === "NotFoundError" || name === "OverconstrainedError" ? "unavailable" : "error",
        });
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [open, facing]);

  const shoot = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || busy) return;
    setBusy(true);
    setFlash((n) => n + 1);
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setBusy(false);
      return;
    }
    // 前置摄像头画面是镜像显示的，保存时还原为正向
    if (facing === "user") {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.92));
    // 留出白闪的时间再关闭
    await new Promise((r) => setTimeout(r, reduce ? 0 : 160));
    setBusy(false);
    if (!blob) return;
    onOpenChange(false);
    onCapture(new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" }));
  };

  const failed = status === "denied" || status === "unavailable" || status === "error";
  const info = describe(status);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>拍照翻译</DialogTitle>
          <DialogDescription>对准要翻译的文字，尽量保持画面清晰、端正。</DialogDescription>
        </DialogHeader>
        <div className="relative aspect-video overflow-hidden rounded-xl bg-neutral-950">
          <video
            ref={videoRef}
            playsInline
            muted
            className={`size-full object-contain transition-opacity duration-300 ${status === "ready" ? "opacity-100" : "opacity-0"} ${facing === "user" ? "-scale-x-100" : ""}`}
          />
          {/* 取景框角标 */}
          {status === "ready" && (
            <div aria-hidden className="pointer-events-none absolute inset-6">
              {["top-0 left-0 border-t-2 border-l-2", "top-0 right-0 border-t-2 border-r-2", "bottom-0 left-0 border-b-2 border-l-2", "right-0 bottom-0 border-r-2 border-b-2"].map((c) => (
                <span key={c} className={`absolute size-7 rounded-sm border-white/80 ${c}`} />
              ))}
            </div>
          )}
          <AnimatePresence>
            {status === "starting" && (
              <motion.div key="starting" exit={{ opacity: 0 }} className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white/80">
                <Loader2Icon className="size-4 animate-spin" />
                正在启动摄像头…
              </motion.div>
            )}
            {failed && (
              <motion.div
                key="failed"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center text-white"
                role="alert"
              >
                <span className="flex size-12 items-center justify-center rounded-2xl bg-white/10">
                  <CameraOffIcon className="size-6" />
                </span>
                <div className="text-sm font-medium">{info.title}</div>
                <p className="max-w-sm text-xs leading-relaxed text-white/70">{info.body}</p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    onOpenChange(false);
                    onUpload();
                  }}
                >
                  <UploadIcon />
                  改为上传图片
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
          {/* 快门白闪 120 ms */}
          <AnimatePresence>
            {flash > 0 && !reduce && (
              <motion.div
                key={flash}
                className="pointer-events-none absolute inset-0 bg-white"
                initial={{ opacity: 0.95 }}
                animate={{ opacity: 0 }}
                transition={{ duration: 0.12, ease: "easeOut" }}
              />
            )}
          </AnimatePresence>
        </div>
        <div className="flex items-center justify-center gap-6 pt-1">
          <span className="w-10" />
          <motion.button
            type="button"
            aria-label="拍照"
            disabled={status !== "ready" || busy}
            onClick={shoot}
            whileTap={reduce ? undefined : { scale: 0.9 }}
            className="group flex size-16 items-center justify-center rounded-full border-4 border-brand/30 outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
          >
            <span className="size-11 rounded-full bg-brand-gradient shadow-brand transition-transform group-hover:scale-105" />
          </motion.button>
          <Button
            variant="outline"
            size="icon-lg"
            className="rounded-full"
            aria-label="切换前后摄像头"
            title={multiple ? "切换前后摄像头" : "只检测到一个摄像头"}
            disabled={status === "starting" || failed || !multiple}
            onClick={() => setFacing((f) => (f === "environment" ? "user" : "environment"))}
          >
            <SwitchCameraIcon />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
