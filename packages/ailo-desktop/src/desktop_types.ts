export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DesktopScopeKind = "virtual_screen" | "screen" | "window" | "region";
export type CoordinateSpace = "virtual_screen" | "screen_local" | "window_local" | "region_local";

export interface DesktopScope {
  kind: DesktopScopeKind;
  bounds: Rect;
  screenIndex?: number;
}

export interface DesktopObservation {
  id: string;
  timestamp: number;
  scope: DesktopScope;
  coordinateSpace: CoordinateSpace;
  imageWidth: number;
  imageHeight: number;
  image: {
    path: string;
    mime: string;
    name: string;
  };
}

export interface DesktopActionResult {
  accepted: boolean;
  executed: boolean;
  action: string;
  timestamp: number;
  observationId?: string;
  error?: string;
  details?: Record<string, unknown>;
}

export interface DesktopVerdict {
  status: "success" | "failure" | "uncertain";
  reason: string;
}
