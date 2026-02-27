/**
 * Browser automation tool using Playwright (Node.js).
 * Single tool with action-based API: start, stop, open, navigate, snapshot,
 * screenshot, click, type, eval, evaluate, resize, handle_dialog, file_upload,
 * fill_form, press_key, drag, hover, select_option, tabs, wait_for, pdf, close.
 */

import { writeFile } from "fs/promises";
import {
  type BrowserContext,
  type Browser,
  type Page,
  type ConsoleMessage,
  type Request,
  type Response,
  type Dialog,
  type FileChooser,
  chromium,
} from "playwright";
import { buildRoleSnapshotFromAria, type RefInfo } from "./browser_snapshot.js";

interface BrowserState {
  browser: Browser | null;
  context: BrowserContext | null;
  pages: Map<string, Page>;
  refs: Map<string, Map<string, RefInfo>>;
  refsFrame: Map<string, string>;
  consoleLogs: Map<string, Array<{ level: string; text: string }>>;
  networkRequests: Map<string, Array<{ url: string; method: string; resourceType?: string; status?: number }>>;
  pendingDialogs: Map<string, Dialog[]>;
  pendingFileChoosers: Map<string, FileChooser[]>;
  headless: boolean;
  currentPageId: string | null;
  pageCounter: number;
}

const state: BrowserState = {
  browser: null,
  context: null,
  pages: new Map(),
  refs: new Map(),
  refsFrame: new Map(),
  consoleLogs: new Map(),
  networkRequests: new Map(),
  pendingDialogs: new Map(),
  pendingFileChoosers: new Map(),
  headless: true,
  currentPageId: null,
  pageCounter: 0,
};

function ok(data: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...data }, null, 2);
}
function fail(error: string): string {
  return JSON.stringify({ ok: false, error }, null, 2);
}

function nextPageId(): string {
  return `page_${++state.pageCounter}`;
}

function getPage(pageId: string): Page | undefined {
  return state.pages.get(pageId);
}

function getRefs(pageId: string): Map<string, RefInfo> {
  if (!state.refs.has(pageId)) state.refs.set(pageId, new Map());
  return state.refs.get(pageId)!;
}

function getRoot(page: Page, frameSelector?: string) {
  if (frameSelector?.trim()) return page.frameLocator(frameSelector.trim());
  return page;
}

function getLocatorByRef(page: Page, pageId: string, ref: string, frameSelector?: string) {
  const refs = getRefs(pageId);
  const info = refs.get(ref);
  if (!info) return null;
  const root = getRoot(page, frameSelector);
  let locator = root.getByRole(info.role as any, { name: info.name || undefined });
  if (info.nth !== undefined && info.nth > 0) locator = locator.nth(info.nth);
  return locator;
}

function attachPageListeners(page: Page, pageId: string): void {
  const logs: Array<{ level: string; text: string }> = [];
  state.consoleLogs.set(pageId, logs);
  page.on("console", (msg: ConsoleMessage) => logs.push({ level: msg.type(), text: msg.text() }));

  const reqs: Array<{ url: string; method: string; resourceType?: string; status?: number }> = [];
  state.networkRequests.set(pageId, reqs);
  page.on("request", (req: Request) => reqs.push({ url: req.url(), method: req.method(), resourceType: req.resourceType() }));
  page.on("response", (res: Response) => {
    const r = reqs.find((x) => x.url === res.url() && x.status === undefined);
    if (r) r.status = res.status();
  });

  const dialogs: Dialog[] = [];
  state.pendingDialogs.set(pageId, dialogs);
  page.on("dialog", (d: Dialog) => dialogs.push(d));

  const choosers: FileChooser[] = [];
  state.pendingFileChoosers.set(pageId, choosers);
  page.on("filechooser", (c: FileChooser) => choosers.push(c));
}

function attachContextListeners(context: BrowserContext): void {
  context.on("page", (page: Page) => {
    const newId = nextPageId();
    state.refs.set(newId, new Map());
    attachPageListeners(page, newId);
    state.pages.set(newId, page);
    state.currentPageId = newId;
  });
}

function resetState(): void {
  state.browser = null;
  state.context = null;
  state.pages.clear();
  state.refs.clear();
  state.refsFrame.clear();
  state.consoleLogs.clear();
  state.networkRequests.clear();
  state.pendingDialogs.clear();
  state.pendingFileChoosers.clear();
  state.currentPageId = null;
  state.pageCounter = 0;
  state.headless = true;
}

function parseJson(value: unknown, fallback: unknown = undefined): unknown {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

// --- Actions ---

async function actionStart(headed: boolean): Promise<string> {
  if (state.browser) {
    if (headed && state.headless) {
      try { await state.browser.close(); } catch {}
      resetState();
    } else {
      return ok({ message: "Browser already running" });
    }
  }
  state.headless = !headed;
  try {
    const browser = await chromium.launch({ headless: state.headless });
    const context = await browser.newContext();
    attachContextListeners(context);
    state.browser = browser;
    state.context = context;
    return ok({ message: headed ? "Browser started (visible window)" : "Browser started" });
  } catch (e: any) {
    return fail(`Browser start failed: ${e.message}`);
  }
}

async function actionStop(): Promise<string> {
  if (!state.browser) return ok({ message: "Browser not running" });
  try { await state.browser.close(); } catch {}
  resetState();
  return ok({ message: "Browser stopped" });
}

async function ensureBrowser(): Promise<boolean> {
  if (state.browser && state.context) return true;
  try {
    const browser = await chromium.launch({ headless: state.headless });
    const context = await browser.newContext();
    attachContextListeners(context);
    state.browser = browser;
    state.context = context;
    return true;
  } catch { return false; }
}

async function actionOpen(url: string, pageId: string): Promise<string> {
  if (!url?.trim()) return fail("url required for open");
  if (!await ensureBrowser()) return fail("Browser not started");
  try {
    const page = await state.context!.newPage();
    state.refs.set(pageId, new Map());
    attachPageListeners(page, pageId);
    await page.goto(url);
    state.pages.set(pageId, page);
    state.currentPageId = pageId;
    return ok({ message: `Opened ${url}`, page_id: pageId, url });
  } catch (e: any) {
    return fail(`Open failed: ${e.message}`);
  }
}

async function actionNavigate(url: string, pageId: string): Promise<string> {
  if (!url?.trim()) return fail("url required for navigate");
  const page = getPage(pageId);
  if (!page) return fail(`Page '${pageId}' not found`);
  try {
    await page.goto(url);
    state.currentPageId = pageId;
    return ok({ message: `Navigated to ${url}`, url: page.url() });
  } catch (e: any) {
    return fail(`Navigate failed: ${e.message}`);
  }
}

async function actionNavigateBack(pageId: string): Promise<string> {
  const page = getPage(pageId);
  if (!page) return fail(`Page '${pageId}' not found`);
  try {
    await page.goBack();
    return ok({ message: "Navigated back", url: page.url() });
  } catch (e: any) {
    return fail(`Navigate back failed: ${e.message}`);
  }
}

async function actionSnapshot(pageId: string, filename?: string, frameSelector?: string): Promise<string> {
  const page = getPage(pageId);
  if (!page) return fail(`Page '${pageId}' not found`);
  try {
    const root = getRoot(page, frameSelector);
    const locator = root.locator(":root");
    const raw = await locator.ariaSnapshot();
    const { snapshot, refs } = buildRoleSnapshotFromAria(raw ?? "");
    state.refs.set(pageId, refs);
    state.refsFrame.set(pageId, frameSelector?.trim() ?? "");

    const out: Record<string, unknown> = { snapshot, refs: [...refs.keys()], url: page.url() };
    if (frameSelector?.trim()) out.frame_selector = frameSelector.trim();
    if (filename?.trim()) {
      await writeFile(filename.trim(), snapshot, "utf-8");
      out.filename = filename.trim();
    }
    return ok(out);
  } catch (e: any) {
    return fail(`Snapshot failed: ${e.message}`);
  }
}

async function actionScreenshot(
  pageId: string, path?: string, fullPage = false,
  screenshotType = "png", ref?: string, frameSelector?: string,
): Promise<string> {
  if (!path?.trim()) path = `page-${Date.now()}.${screenshotType === "jpeg" ? "jpeg" : "png"}`;
  const page = getPage(pageId);
  if (!page) return fail(`Page '${pageId}' not found`);
  try {
    const type = screenshotType === "jpeg" ? "jpeg" : "png";
    if (ref?.trim()) {
      const locator = getLocatorByRef(page, pageId, ref.trim(), frameSelector);
      if (!locator) return fail(`Unknown ref: ${ref}`);
      await locator.screenshot({ path, type });
    } else if (frameSelector?.trim()) {
      const root = getRoot(page, frameSelector);
      await root.locator("body").first().screenshot({ path, type });
    } else {
      await page.screenshot({ path, fullPage, type });
    }
    return ok({ message: `Screenshot saved to ${path}`, path });
  } catch (e: any) {
    return fail(`Screenshot failed: ${e.message}`);
  }
}

async function actionClick(
  pageId: string, selector?: string, ref?: string,
  wait = 0, doubleClick = false, button = "left",
  modifiersJson?: string, frameSelector?: string,
): Promise<string> {
  if (!ref?.trim() && !selector?.trim()) return fail("selector or ref required for click");
  const page = getPage(pageId);
  if (!page) return fail(`Page '${pageId}' not found`);
  try {
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const mods = (parseJson(modifiersJson, []) as string[]) ?? [];
    const validMods = mods.filter((m) => ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"].includes(m));
    const opts: any = { button: ["left", "right", "middle"].includes(button) ? button : "left" };
    if (validMods.length) opts.modifiers = validMods;

    if (ref?.trim()) {
      const locator = getLocatorByRef(page, pageId, ref.trim(), frameSelector);
      if (!locator) return fail(`Unknown ref: ${ref}`);
      if (doubleClick) await locator.dblclick(opts); else await locator.click(opts);
    } else {
      const root = getRoot(page, frameSelector);
      const locator = root.locator(selector!).first();
      if (doubleClick) await locator.dblclick(opts); else await locator.click(opts);
    }
    return ok({ message: `Clicked ${ref || selector}` });
  } catch (e: any) {
    return fail(`Click failed: ${e.message}`);
  }
}

async function actionType(
  pageId: string, selector?: string, ref?: string,
  text = "", submit = false, slowly = false, frameSelector?: string,
): Promise<string> {
  if (!ref?.trim() && !selector?.trim()) return fail("selector or ref required for type");
  const page = getPage(pageId);
  if (!page) return fail(`Page '${pageId}' not found`);
  try {
    let locator;
    if (ref?.trim()) {
      locator = getLocatorByRef(page, pageId, ref.trim(), frameSelector);
      if (!locator) return fail(`Unknown ref: ${ref}`);
    } else {
      const root = getRoot(page, frameSelector);
      locator = root.locator(selector!).first();
    }
    if (slowly) await locator.pressSequentially(text); else await locator.fill(text);
    if (submit) await locator.press("Enter");
    return ok({ message: `Typed into ${ref || selector}` });
  } catch (e: any) {
    return fail(`Type failed: ${e.message}`);
  }
}

async function actionEval(pageId: string, code: string): Promise<string> {
  if (!code?.trim()) return fail("code required for eval");
  const page = getPage(pageId);
  if (!page) return fail(`Page '${pageId}' not found`);
  try {
    const expr = code.trim().startsWith("(") || code.trim().startsWith("function")
      ? code : `() => { return (${code}); }`;
    const result = await page.evaluate(expr);
    return ok({ result });
  } catch (e: any) {
    return fail(`Eval failed: ${e.message}`);
  }
}

async function actionEvaluate(
  pageId: string, code: string, ref?: string, frameSelector?: string,
): Promise<string> {
  if (!code?.trim()) return fail("code required for evaluate");
  const page = getPage(pageId);
  if (!page) return fail(`Page '${pageId}' not found`);
  try {
    let result;
    if (ref?.trim()) {
      const locator = getLocatorByRef(page, pageId, ref.trim(), frameSelector);
      if (!locator) return fail(`Unknown ref: ${ref}`);
      result = await locator.evaluate(code);
    } else {
      const expr = code.trim().startsWith("(") || code.trim().startsWith("function")
        ? code : `() => { return (${code}); }`;
      result = await page.evaluate(expr);
    }
    return ok({ result });
  } catch (e: any) {
    return fail(`Evaluate failed: ${e.message}`);
  }
}

async function actionResize(pageId: string, width: number, height: number): Promise<string> {
  if (width <= 0 || height <= 0) return fail("width and height must be positive");
  const page = getPage(pageId);
  if (!page) return fail(`Page '${pageId}' not found`);
  try {
    await page.setViewportSize({ width, height });
    return ok({ message: `Resized to ${width}x${height}` });
  } catch (e: any) {
    return fail(`Resize failed: ${e.message}`);
  }
}

async function actionConsoleMessages(pageId: string, level = "info", filename?: string): Promise<string> {
  const page = getPage(pageId);
  if (!page) return fail(`Page '${pageId}' not found`);
  const order = ["error", "warning", "info", "debug"];
  const idx = order.indexOf(level.toLowerCase());
  const logs = state.consoleLogs.get(pageId) ?? [];
  const filtered = idx >= 0 ? logs.filter((m) => order.indexOf(m.level) <= idx) : logs;
  const text = filtered.map((m) => `[${m.level}] ${m.text}`).join("\n");
  if (filename?.trim()) {
    await writeFile(filename.trim(), text, "utf-8");
    return ok({ message: `Console messages saved to ${filename}`, filename: filename.trim() });
  }
  return ok({ messages: filtered, text });
}

async function actionHandleDialog(pageId: string, accept = true, promptText?: string): Promise<string> {
  const page = getPage(pageId);
  if (!page) return fail(`Page '${pageId}' not found`);
  const dialogs = state.pendingDialogs.get(pageId) ?? [];
  if (!dialogs.length) return fail("No pending dialog");
  try {
    const dialog = dialogs.shift();
    if (!dialog) return fail("No pending dialog");
    if (accept) {
      if (promptText) await dialog.accept(promptText); else await dialog.accept();
    } else {
      await dialog.dismiss();
    }
    return ok({ message: "Dialog handled" });
  } catch (e: unknown) {
    return fail(`Handle dialog failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function actionFileUpload(pageId: string, pathsJson?: string): Promise<string> {
  const page = getPage(pageId);
  if (!page) return fail(`Page '${pageId}' not found`);
  const paths = (parseJson(pathsJson, []) as string[]) ?? [];
  const choosers = state.pendingFileChoosers.get(pageId) ?? [];
  if (!choosers.length) return fail("No chooser. Click upload then file_upload.");
  try {
    const chooser = choosers.shift();
    if (!chooser) return fail("No file chooser");
    await chooser.setFiles(paths);
    return ok({ message: paths.length ? `Uploaded ${paths.length} file(s)` : "File chooser cancelled" });
  } catch (e: unknown) {
    return fail(`File upload failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function actionFillForm(pageId: string, fieldsJson?: string): Promise<string> {
  const page = getPage(pageId);
  if (!page) return fail(`Page '${pageId}' not found`);
  const fields = parseJson(fieldsJson, []) as Array<{ ref: string; type?: string; value: unknown }>;
  if (!Array.isArray(fields) || !fields.length) return fail("fields required (JSON array)");
  const refs = getRefs(pageId);
  const frame = state.refsFrame.get(pageId) ?? "";
  try {
    for (const f of fields) {
      const refId = f.ref?.trim();
      if (!refId || !refs.has(refId)) continue;
      const locator = getLocatorByRef(page, pageId, refId, frame);
      if (!locator) continue;
      const fieldType = (f.type ?? "textbox").toLowerCase();
      if (fieldType === "checkbox") {
        const checked = typeof f.value === "string"
          ? ["true", "1", "yes"].includes(f.value.toLowerCase()) : !!f.value;
        await locator.setChecked(checked);
      } else if (fieldType === "radio") {
        await locator.setChecked(true);
      } else if (fieldType === "combobox") {
        await locator.selectOption(typeof f.value === "string" ? { label: f.value } : { value: String(f.value) });
      } else {
        await locator.fill(f.value != null ? String(f.value) : "");
      }
    }
    return ok({ message: `Filled ${fields.length} field(s)` });
  } catch (e: any) {
    return fail(`Fill form failed: ${e.message}`);
  }
}

async function actionPressKey(pageId: string, key: string): Promise<string> {
  if (!key?.trim()) return fail("key required for press_key");
  const page = getPage(pageId);
  if (!page) return fail(`Page '${pageId}' not found`);
  try {
    await page.keyboard.press(key.trim());
    return ok({ message: `Pressed key ${key}` });
  } catch (e: any) {
    return fail(`Press key failed: ${e.message}`);
  }
}

async function actionNetworkRequests(pageId: string, includeStatic = false, filename?: string): Promise<string> {
  const page = getPage(pageId);
  if (!page) return fail(`Page '${pageId}' not found`);
  let reqs = state.networkRequests.get(pageId) ?? [];
  if (!includeStatic) {
    const staticTypes = new Set(["image", "stylesheet", "font", "media"]);
    reqs = reqs.filter((r) => !staticTypes.has(r.resourceType ?? ""));
  }
  const text = reqs.map((r) => `${r.method} ${r.url} ${r.status ?? ""}`).join("\n");
  if (filename?.trim()) {
    await writeFile(filename.trim(), text, "utf-8");
    return ok({ message: `Network requests saved to ${filename}`, filename: filename.trim() });
  }
  return ok({ requests: reqs, text });
}

async function actionDrag(
  pageId: string, startRef?: string, endRef?: string,
  startSelector?: string, endSelector?: string, frameSelector?: string,
): Promise<string> {
  const useRefs = !!(startRef?.trim() && endRef?.trim());
  const useSelectors = !!(startSelector?.trim() && endSelector?.trim());
  if (!useRefs && !useSelectors) return fail("drag needs (start_ref,end_ref) or (start_selector,end_selector)");
  const page = getPage(pageId);
  if (!page) return fail(`Page '${pageId}' not found`);
  try {
    let startLocator, endLocator;
    if (useRefs) {
      startLocator = getLocatorByRef(page, pageId, startRef!.trim(), frameSelector);
      endLocator = getLocatorByRef(page, pageId, endRef!.trim(), frameSelector);
      if (!startLocator || !endLocator) return fail("Unknown ref for drag");
    } else {
      const root = getRoot(page, frameSelector);
      startLocator = root.locator(startSelector!).first();
      endLocator = root.locator(endSelector!).first();
    }
    await startLocator.dragTo(endLocator);
    return ok({ message: "Drag completed" });
  } catch (e: any) {
    return fail(`Drag failed: ${e.message}`);
  }
}

async function actionHover(
  pageId: string, ref?: string, selector?: string, frameSelector?: string,
): Promise<string> {
  if (!ref?.trim() && !selector?.trim()) return fail("hover requires ref or selector");
  const page = getPage(pageId);
  if (!page) return fail(`Page '${pageId}' not found`);
  try {
    let locator;
    if (ref?.trim()) {
      locator = getLocatorByRef(page, pageId, ref.trim(), frameSelector);
      if (!locator) return fail(`Unknown ref: ${ref}`);
    } else {
      const root = getRoot(page, frameSelector);
      locator = root.locator(selector!).first();
    }
    await locator.hover();
    return ok({ message: `Hovered ${ref || selector}` });
  } catch (e: any) {
    return fail(`Hover failed: ${e.message}`);
  }
}

async function actionSelectOption(
  pageId: string, ref?: string, valuesJson?: string, frameSelector?: string,
): Promise<string> {
  if (!ref?.trim()) return fail("ref required for select_option");
  const values = parseJson(valuesJson, []) as string[];
  if (!Array.isArray(values) || !values.length) return fail("values required (JSON array or comma-separated)");
  const page = getPage(pageId);
  if (!page) return fail(`Page '${pageId}' not found`);
  try {
    const locator = getLocatorByRef(page, pageId, ref!.trim(), frameSelector);
    if (!locator) return fail(`Unknown ref: ${ref}`);
    await locator.selectOption(values);
    return ok({ message: `Selected ${JSON.stringify(values)}` });
  } catch (e: any) {
    return fail(`Select option failed: ${e.message}`);
  }
}

async function actionTabs(pageId: string, tabAction: string, index: number): Promise<string> {
  if (!tabAction?.trim()) return fail("tab_action required (list, new, close, select)");
  const pageIds = [...state.pages.keys()];
  const act = tabAction.trim().toLowerCase();

  if (act === "list") return ok({ tabs: pageIds, count: pageIds.length });

  if (act === "new") {
    if (!state.context && !await ensureBrowser()) return fail("Browser not started");
    try {
      const page = await state.context!.newPage();
      const newId = nextPageId();
      state.refs.set(newId, new Map());
      attachPageListeners(page, newId);
      state.pages.set(newId, page);
      state.currentPageId = newId;
      return ok({ page_id: newId, tabs: [...state.pages.keys()] });
    } catch (e: any) {
      return fail(`New tab failed: ${e.message}`);
    }
  }

  const targetId = index >= 0 && index < pageIds.length ? pageIds[index] : pageId;
  if (act === "close") return actionClose(targetId);
  if (act === "select") {
    state.currentPageId = targetId;
    return ok({ message: `Use page_id=${targetId} for later actions`, page_id: targetId });
  }
  return fail(`Unknown tab_action: ${tabAction}`);
}

async function actionWaitFor(pageId: string, waitTime: number, text?: string, textGone?: string): Promise<string> {
  const page = getPage(pageId);
  if (!page) return fail(`Page '${pageId}' not found`);
  try {
    if (waitTime > 0) await new Promise((r) => setTimeout(r, waitTime * 1000));
    if (text?.trim()) await page.getByText(text.trim()).waitFor({ state: "visible", timeout: 30000 });
    if (textGone?.trim()) await page.getByText(textGone.trim()).waitFor({ state: "hidden", timeout: 30000 });
    return ok({ message: "Wait completed" });
  } catch (e: any) {
    return fail(`Wait failed: ${e.message}`);
  }
}

async function actionPdf(pageId: string, path?: string): Promise<string> {
  const p = path?.trim() || "page.pdf";
  const page = getPage(pageId);
  if (!page) return fail(`Page '${pageId}' not found`);
  try {
    await page.pdf({ path: p });
    return ok({ message: `PDF saved to ${p}`, path: p });
  } catch (e: any) {
    return fail(`PDF failed: ${e.message}`);
  }
}

async function actionClose(pageId: string): Promise<string> {
  const page = getPage(pageId);
  if (!page) return fail(`Page '${pageId}' not found`);
  try {
    await page.close();
    state.pages.delete(pageId);
    state.refs.delete(pageId);
    state.refsFrame.delete(pageId);
    state.consoleLogs.delete(pageId);
    state.networkRequests.delete(pageId);
    state.pendingDialogs.delete(pageId);
    state.pendingFileChoosers.delete(pageId);
    if (state.currentPageId === pageId) {
      const remaining = [...state.pages.keys()];
      state.currentPageId = remaining[0] ?? null;
    }
    return ok({ message: `Closed page '${pageId}'` });
  } catch (e: any) {
    return fail(`Close failed: ${e.message}`);
  }
}

// --- Main entry ---

export async function browserUse(args: Record<string, unknown>): Promise<string> {
  const action = (String(args.action ?? "")).trim().toLowerCase();
  if (!action) return fail("action required");

  let pageId = (String(args.page_id ?? "default")).trim() || "default";
  if (pageId === "default" && state.currentPageId && state.pages.has(state.currentPageId)) {
    pageId = state.currentPageId;
  }

  try {
    switch (action) {
      case "start": return await actionStart(!!args.headed);
      case "stop": return await actionStop();
      case "open": return await actionOpen(String(args.url ?? ""), pageId);
      case "navigate": return await actionNavigate(String(args.url ?? ""), pageId);
      case "navigate_back": return await actionNavigateBack(pageId);
      case "snapshot": return await actionSnapshot(pageId, args.filename as string, args.frame_selector as string);
      case "screenshot":
      case "take_screenshot":
        return await actionScreenshot(
          pageId, args.path as string ?? args.filename as string,
          !!args.full_page, String(args.screenshot_type ?? "png"),
          args.ref as string, args.frame_selector as string,
        );
      case "click":
        return await actionClick(
          pageId, args.selector as string, args.ref as string,
          Number(args.wait ?? 0), !!args.double_click,
          String(args.button ?? "left"), args.modifiers_json as string, args.frame_selector as string,
        );
      case "type":
        return await actionType(
          pageId, args.selector as string, args.ref as string,
          String(args.text ?? ""), !!args.submit, !!args.slowly, args.frame_selector as string,
        );
      case "eval": return await actionEval(pageId, String(args.code ?? ""));
      case "evaluate":
        return await actionEvaluate(pageId, String(args.code ?? ""), args.ref as string, args.frame_selector as string);
      case "resize": return await actionResize(pageId, Number(args.width ?? 0), Number(args.height ?? 0));
      case "console_messages":
        return await actionConsoleMessages(pageId, String(args.level ?? "info"), args.filename as string ?? args.path as string);
      case "handle_dialog":
        return await actionHandleDialog(pageId, args.accept !== false, args.prompt_text as string);
      case "file_upload": return await actionFileUpload(pageId, args.paths_json as string);
      case "fill_form": return await actionFillForm(pageId, args.fields_json as string);
      case "press_key": return await actionPressKey(pageId, String(args.key ?? ""));
      case "network_requests":
        return await actionNetworkRequests(pageId, !!args.include_static, args.filename as string ?? args.path as string);
      case "drag":
        return await actionDrag(
          pageId, args.start_ref as string, args.end_ref as string,
          args.start_selector as string, args.end_selector as string, args.frame_selector as string,
        );
      case "hover": return await actionHover(pageId, args.ref as string, args.selector as string, args.frame_selector as string);
      case "select_option":
        return await actionSelectOption(pageId, args.ref as string, args.values_json as string, args.frame_selector as string);
      case "tabs": return await actionTabs(pageId, String(args.tab_action ?? ""), Number(args.index ?? -1));
      case "wait_for":
        return await actionWaitFor(pageId, Number(args.wait_time ?? 0), args.text as string, args.text_gone as string);
      case "pdf": return await actionPdf(pageId, args.path as string);
      case "close": return await actionClose(pageId);
      case "install": return await actionInstall();
      default: return fail(`Unknown action: ${action}`);
    }
  } catch (e: any) {
    return fail(e.message);
  }
}

async function actionInstall(): Promise<string> {
  try {
    const { execSync } = await import("child_process");
    execSync("npx playwright install chromium", { stdio: "pipe", timeout: 120000 });
    return ok({ message: "Chromium browser installed" });
  } catch (e: any) {
    return fail(`Install failed: ${e.message}`);
  }
}

export async function stopBrowser(): Promise<void> {
  if (state.browser) {
    try { await state.browser.close(); } catch {}
    resetState();
  }
}
