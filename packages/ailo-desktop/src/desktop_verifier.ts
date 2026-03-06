import { readFileSync } from "fs";
import type { DesktopActionResult, DesktopObservation, DesktopVerdict } from "./desktop_types.js";

function imagesDiffer(beforePath: string, afterPath: string): boolean {
  const before = readFileSync(beforePath);
  const after = readFileSync(afterPath);
  return !before.equals(after);
}

export function verifyDesktopAction(args: {
  beforeObservation: DesktopObservation | null;
  afterObservation: DesktopObservation | null;
  actionResult: DesktopActionResult;
}): DesktopVerdict {
  const { beforeObservation, afterObservation, actionResult } = args;
  if (!actionResult.accepted) {
    return { status: "failure", reason: actionResult.error ?? "动作被拒绝执行" };
  }
  if (!actionResult.executed) {
    return { status: "failure", reason: actionResult.error ?? "动作未执行" };
  }
  if (!beforeObservation || !afterObservation) {
    return { status: "uncertain", reason: "缺少动作前后 observation，无法完成验证" };
  }
  try {
    if (imagesDiffer(beforeObservation.image.path, afterObservation.image.path)) {
      return { status: "success", reason: "动作后界面发生变化" };
    }
    return { status: "uncertain", reason: "动作后未观察到明显界面变化" };
  } catch (error) {
    return {
      status: "uncertain",
      reason: `无法比较动作前后截图: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
