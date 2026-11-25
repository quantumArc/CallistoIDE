/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export const BROWSER_SERVICE_PATH = '/services/callisto/browser';

/** The agent's tool for looking at a web page it built: open it, use it, read its console, see a screenshot. */
export const BROWSER_FUNCTION_ID = 'browser';

export const BrowserService = Symbol('BrowserService');

export type BrowserActionKind = 'click' | 'type' | 'press' | 'select' | 'hover' | 'drag' | 'scroll' | 'wait';

/** One step done on the page, in the shape the model writes it. */
export interface BrowserAction {
    action: BrowserActionKind;
    /** CSS selector of the element to act on. */
    selector?: string;
    /** Visible text of the element to act on (a button's label, a link's text), when there is no handy selector. */
    text?: string;
    /** Page coordinates in CSS pixels, as in the screenshot: for canvases and other things without elements to target. */
    x?: number;
    y?: number;
    /** End point of a drag. */
    toX?: number;
    toY?: number;
    /** `type`: the text to type. `select`: the option's value or label. */
    value?: string;
    /** `press`: a key name such as "Enter", "Escape", "ArrowLeft" or "a". */
    key?: string;
    /** `scroll`: pixels down (negative: up). */
    deltaY?: number;
    /** `wait`: milliseconds. */
    ms?: number;
}

export interface BrowserRequest {
    /**
     * The page to open: an `http(s)` URL on this machine, or `file` with the absolute path of an HTML file inside `root`,
     * which Callisto serves over HTTP from `root` (ES modules and fetch do not work from `file://`). Absent: keep using
     * the page that is open.
     */
    open?: { url: string } | { file: string; root: string };
    actions?: BrowserAction[];
    /** A JavaScript expression (or function body with `return`) evaluated in the page after the actions. */
    evaluate?: string;
    /** Whether to take a screenshot (default true). */
    screenshot?: boolean;
    /** Viewport size in CSS pixels; default 1280×800. */
    width?: number;
    height?: number;
    /** Extra milliseconds to wait after loading and after the actions, for animations (default 500 after a load). */
    waitMs?: number;
    /** Chrome or Chromium to use; empty to look for one. */
    executablePath?: string;
}

export interface BrowserLogEntry {
    /** 'error', 'warning', 'log', 'info', 'debug' for console messages; 'exception' for uncaught errors; 'network' for failed requests. */
    kind: string;
    text: string;
    /** Where it came from: `url:line` for console messages and exceptions, the URL for network failures. */
    source?: string;
    /** How many times the same entry occurred in a row. */
    count: number;
}

export interface BrowserElementSummary {
    /** e.g. `button`, `a`, `input[type=text]`, `select`, `canvas`. */
    tag: string;
    /** Its label: text, value, aria-label, placeholder or title. */
    label: string;
    /** A selector that finds it, when it has an id or a unique name. */
    selector?: string;
    /** Centre, in CSS pixels. */
    x: number;
    y: number;
    width: number;
    height: number;
    disabled?: boolean;
}

export interface BrowserResult {
    /** The page's URL after the call; absent when no page is open. */
    url?: string;
    /** The workspace file the URL stands for, when Callisto serves it. */
    workspacePath?: string;
    title?: string;
    /** HTTP status of the page when this call loaded it. */
    status?: number;
    viewport: { width: number; height: number };
    /** What each action did, in order; stops at the first that failed. */
    actions: { ok: boolean; message: string }[];
    /** Console messages, uncaught exceptions and failed requests since the page loaded or the previous call, whichever is later. */
    log: BrowserLogEntry[];
    /** Entries left out because there were too many. */
    logOmitted: number;
    evaluate?: { ok: boolean; value: string };
    /** The page's visible text, shortened. */
    text?: string;
    /** Visible interactive elements and canvases, top to bottom. */
    elements: BrowserElementSummary[];
    screenshot?: { base64: string; mimeType: 'image/jpeg' | 'image/png' };
    /** Which browser ran the page, e.g. "chrome-headless-shell 149.0.7827.22". */
    browser?: string;
    /** What the log suggests doing, for problems a model tends to misread (a bare module import, a page that answered 404). */
    hints?: string[];
    /** Set when the call could not run at all (no browser found, page did not load). */
    error?: string;
}

/** The agent's tool for looking at a 3D object it built: several views in one image, and geometry checks. */
export const VIEW3D_FUNCTION_ID = 'view3d';

/** Model files view3d opens with three.js's own loaders. */
export const VIEW3D_MODEL_EXTENSIONS = ['.glb', '.gltf', '.obj', '.stl', '.ply', '.fbx'];

export interface View3dRequest {
    /**
     * Absolute path of the file to show, inside `root`: a JavaScript module that builds the object with three.js, or a
     * model file ({@link VIEW3D_MODEL_EXTENSIONS}).
     */
    file: string;
    root: string;
    /** Module: the export to show, a function that returns the object or the object itself. Default: the default export. */
    exportName?: string;
    /** Module: argument lists, one object per list, shown side by side. Default: one call without arguments. */
    calls?: unknown[][];
    /** Draw the object's own materials instead of plain grey clay. */
    materials?: boolean;
    executablePath?: string;
}

export interface View3dObject {
    /** e.g. `buildPieceMesh("n", "w")`, or the file name of a model. */
    label: string;
    /** e.g. "0.64 wide (x) × 0.70 tall (y) × 0.23 deep (z)". */
    sizeText: string;
    /** Lowest y, formatted. */
    bottomText: string;
    /** Centre of its footprint, e.g. "x 0.00, z 0.00". */
    centerText: string;
    parts: number;
    triangles: number;
    /** e.g. "1 LatheGeometry, 8 SphereGeometry". */
    partTypes: string;
    /** One line per part (the first few): type, size and position. */
    partList: string[];
    partsOmitted: number;
    /** What the checks found: loose parts, holes, coarse lathe profiles, flat extrusions, missing normals. */
    warnings: View3dWarning[];
}

export interface View3dWarning {
    /** What is wrong, with the part and where it is. */
    text: string;
    /** How to fix it; the same for every warning of a kind, so a report says it once. */
    fix?: string;
}

export interface View3dResult {
    /** The file shown, relative to the workspace root. */
    workspacePath?: string;
    /** The module export that was shown. */
    exportName?: string;
    objects: View3dObject[];
    /** Findings across objects, e.g. two that share an identical part. */
    notes: string[];
    /** three.js revision the page ran, e.g. "160". */
    revision?: string;
    /** Where three.js came from, e.g. "node_modules/three" or an import map in index.html. */
    threeFrom?: string;
    materials: boolean;
    log: BrowserLogEntry[];
    logOmitted: number;
    screenshot?: { base64: string; mimeType: 'image/jpeg' | 'image/png' };
    viewport: { width: number; height: number };
    browser?: string;
    hints?: string[];
    error?: string;
}

/**
 * A headless Chrome in the backend that the agent drives through {@link BROWSER_FUNCTION_ID}. One page is kept open
 * between calls, so the agent can open a page, look, click, and look again; it is closed after a few idle minutes.
 * {@link VIEW3D_FUNCTION_ID} draws objects on a second page of the same browser.
 */
export interface BrowserService {
    run(request: BrowserRequest): Promise<BrowserResult>;
    view3d(request: View3dRequest): Promise<View3dResult>;
    close(): Promise<void>;
}
