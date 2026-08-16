import { useCallback, useEffect, useRef, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export type AppUpdateStatus = "unsupported" | "idle" | "checking" | "latest" | "available" | "downloading" | "restarting" | "error";

export type AppUpdater = {
  supported: boolean;
  status: AppUpdateStatus;
  version: string | null;
  body: string;
  date: string | null;
  progress: number | null;
  error: string;
  checkForUpdates: () => Promise<void>;
  installUpdate: () => Promise<void>;
};

export function useAppUpdater(): AppUpdater {
  const supported = import.meta.env.PROD && typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const updateRef = useRef<Update | null>(null);
  const autoCheckStartedRef = useRef(false);
  const [status, setStatus] = useState<AppUpdateStatus>(supported ? "idle" : "unsupported");
  const [version, setVersion] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [date, setDate] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");

  const checkForUpdates = useCallback(async () => {
    if (!supported || status === "checking" || status === "downloading" || status === "restarting") return;
    setStatus("checking");
    setError("");
    setProgress(null);
    try {
      const update = await check({ timeout: 15000 });
      if (!update) {
        updateRef.current = null;
        setVersion(null);
        setBody("");
        setDate(null);
        setStatus("latest");
        return;
      }
      updateRef.current = update;
      setVersion(update.version);
      setBody(update.body ?? "");
      setDate(update.date ?? null);
      setStatus("available");
    } catch (checkError) {
      setError(errorMessage(checkError, "更新检查失败"));
      setStatus("error");
    }
  }, [status, supported]);

  const installUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!supported || !update || status !== "available") return;
    let downloaded = 0;
    let contentLength: number | undefined;
    setStatus("downloading");
    setError("");
    setProgress(null);
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength;
          setProgress(contentLength ? 0 : null);
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (contentLength) setProgress(Math.min(100, Math.round((downloaded / contentLength) * 100)));
        } else if (event.event === "Finished") {
          setProgress(100);
        }
      });
      setStatus("restarting");
      await relaunch();
    } catch (installError) {
      setError(errorMessage(installError, "更新安装失败"));
      setStatus("error");
    }
  }, [status, supported]);

  useEffect(() => {
    if (!supported || autoCheckStartedRef.current) return;
    autoCheckStartedRef.current = true;
    const timer = window.setTimeout(() => { void checkForUpdates(); }, 2500);
    return () => window.clearTimeout(timer);
  }, [checkForUpdates, supported]);

  return { supported, status, version, body, date, progress, error, checkForUpdates, installUpdate };
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === "string" && error ? error : fallback;
}
