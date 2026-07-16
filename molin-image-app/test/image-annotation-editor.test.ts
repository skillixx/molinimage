import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

interface AnnotationEditor {
  exportPngBlob(): Promise<Blob>;
  hasAnnotations(): boolean;
  loadImage(url: string): Promise<void>;
  reset(): void;
  setColor(color: string): void;
  setTool(tool: string): void;
  setWidth(width: number): void;
  undo(): void;
}

interface AnnotationModule {
  createImageAnnotationEditor(canvas: unknown): AnnotationEditor;
}

interface FakePointerEvent {
  clientX: number;
  clientY: number;
  pointerId: number;
}

const annotationModule = (await import(
  pathToFileURL(resolve("public", "assets", "image-annotation-editor.js")).href
)) as AnnotationModule;

void test("标注画布支持画笔、编号、撤销、清空和 PNG 导出", async () => {
  const listeners = new Map<string, (event: FakePointerEvent) => void>();
  const context = createFakeContext();
  const canvas = {
    width: 0,
    height: 0,
    addEventListener(name: string, listener: (event: FakePointerEvent) => void) {
      listeners.set(name, listener);
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 600, height: 400 };
    },
    getContext() {
      return context;
    },
    hasPointerCapture() {
      return true;
    },
    releasePointerCapture() {
      return undefined;
    },
    setPointerCapture() {
      return undefined;
    },
    toBlob(callback: (blob: Blob | null) => void) {
      callback(new Blob(["annotation"], { type: "image/png" }));
    }
  };
  const originalFetch = globalThis.fetch;
  const runtime = globalThis as unknown as { Image: typeof FakeImage };
  const originalImage = runtime.Image;

  globalThis.fetch = () =>
    Promise.resolve(new Response(new Blob(["image"], { type: "image/png" })));
  runtime.Image = FakeImage;

  try {
    const editor = annotationModule.createImageAnnotationEditor(canvas);

    await editor.loadImage("/api/files/input/preview");
    assert.equal(canvas.width, 1200);
    assert.equal(canvas.height, 800);

    listeners.get("pointerdown")?.({ clientX: 100, clientY: 100, pointerId: 1 });
    listeners.get("pointermove")?.({ clientX: 180, clientY: 160, pointerId: 1 });
    listeners.get("pointerup")?.({ clientX: 180, clientY: 160, pointerId: 1 });
    assert.equal(editor.hasAnnotations(), true);

    editor.undo();
    assert.equal(editor.hasAnnotations(), false);

    editor.setTool("marker");
    editor.setColor("#00a9c6");
    editor.setWidth(10);
    listeners.get("pointerdown")?.({ clientX: 240, clientY: 180, pointerId: 2 });
    assert.equal(editor.hasAnnotations(), true);

    const exported = await editor.exportPngBlob();
    assert.equal(exported.type, "image/png");

    editor.reset();
    assert.equal(editor.hasAnnotations(), false);
  } finally {
    globalThis.fetch = originalFetch;
    runtime.Image = originalImage;
  }
});

class FakeImage {
  naturalHeight = 800;
  naturalWidth = 1200;
  src = "";

  decode() {
    return Promise.resolve();
  }
}

function createFakeContext() {
  const noop = () => undefined;

  return {
    fillStyle: "",
    font: "",
    globalAlpha: 1,
    lineCap: "",
    lineJoin: "",
    lineWidth: 1,
    strokeStyle: "",
    textAlign: "",
    textBaseline: "",
    arc: noop,
    beginPath: noop,
    clearRect: noop,
    drawImage: noop,
    fill: noop,
    fillRect: noop,
    fillText: noop,
    lineTo: noop,
    moveTo: noop,
    restore: noop,
    save: noop,
    stroke: noop,
    strokeRect: noop
  };
}
