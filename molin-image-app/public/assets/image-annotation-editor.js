const MAX_CANVAS_DIMENSION = 1600;

export function createImageAnnotationEditor(canvas) {
  const context = canvas.getContext("2d");

  if (context === null) {
    throw new Error("当前浏览器不支持图片标注画布。");
  }

  // Node 单元测试没有 document；此时退回传入画布，浏览器中仍使用独立透明图层。
  const annotationLayer =
    typeof document === "undefined" ? canvas : document.createElement("canvas");
  const annotationContext = annotationLayer.getContext("2d");
  const hasSeparateAnnotationLayer = annotationLayer !== canvas;

  if (annotationContext === null) {
    throw new Error("当前浏览器不支持图片标注图层。");
  }

  let drawContext = annotationContext;

  const state = {
    image: null,
    imageObjectUrl: null,
    operations: [],
    draft: null,
    tool: "brush",
    color: "#ff3b30",
    width: 6,
    drawing: false
  };

  canvas.addEventListener("pointerdown", handlePointerDown);
  canvas.addEventListener("pointermove", handlePointerMove);
  canvas.addEventListener("pointerup", handlePointerUp);
  canvas.addEventListener("pointercancel", handlePointerUp);

  async function loadImage(previewUrl) {
    releaseImageObjectUrl();
    const response = await fetch(previewUrl, { credentials: "same-origin" });

    if (!response.ok) {
      throw new Error("原图加载失败，请刷新作品历史后重试。");
    }

    state.imageObjectUrl = URL.createObjectURL(await response.blob());
    state.image = await loadImageElement(state.imageObjectUrl);
    state.operations = [];
    state.draft = null;
    state.drawing = false;

    // 大图按最长边缩放到 1600 像素，兼顾标注精度和浏览器内存占用。
    const scale = Math.min(
      1,
      MAX_CANVAS_DIMENSION / Math.max(state.image.naturalWidth, state.image.naturalHeight)
    );
    canvas.width = Math.max(1, Math.round(state.image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(state.image.naturalHeight * scale));
    if (hasSeparateAnnotationLayer) {
      annotationLayer.width = canvas.width;
      annotationLayer.height = canvas.height;
    }
    redraw();
  }

  function setTool(tool) {
    if (!new Set(["brush", "rectangle", "marker", "eraser"]).has(tool)) {
      return;
    }

    state.tool = tool;
  }

  function setColor(color) {
    state.color = color;
  }

  function setWidth(width) {
    const parsed = Number(width);

    if (Number.isFinite(parsed)) {
      state.width = Math.min(18, Math.max(2, parsed));
    }
  }

  function undo() {
    state.operations.pop();
    redraw();
  }

  function reset() {
    state.operations = [];
    state.draft = null;
    redraw();
  }

  function hasAnnotations() {
    return state.operations.length > 0;
  }

  async function exportPngBlob() {
    if (state.image === null) {
      throw new Error("标注图片尚未加载完成。");
    }

    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob === null) {
          reject(new Error("标注图片导出失败，请重试。"));
          return;
        }

        resolve(blob);
      }, "image/png");
    });
  }

  function handlePointerDown(event) {
    if (state.image === null) {
      return;
    }

    const point = resolveCanvasPoint(event);
    canvas.setPointerCapture(event.pointerId);

    if (state.tool === "marker") {
      state.operations.push({
        type: "marker",
        point,
        color: state.color,
        number: countMarkers() + 1
      });
      redraw();
      return;
    }

    state.drawing = true;
    state.draft =
      state.tool === "rectangle"
        ? {
            type: "rectangle",
            start: point,
            end: point,
            color: state.color,
            width: state.width
          }
        : {
            type: state.tool,
            points: [point],
            color: state.color,
            width: state.width
          };
  }

  function handlePointerMove(event) {
    if (!state.drawing || state.draft === null) {
      return;
    }

    const point = resolveCanvasPoint(event);

    if (state.draft.type === "brush") {
      state.draft.points.push(point);
    } else {
      state.draft.end = point;
    }

    redraw();
  }

  function handlePointerUp(event) {
    if (!state.drawing || state.draft === null) {
      return;
    }

    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }

    state.operations.push(state.draft);
    state.draft = null;
    state.drawing = false;
    redraw();
  }

  function redraw() {
    context.clearRect(0, 0, canvas.width, canvas.height);

    if (state.image === null) {
      return;
    }

    context.drawImage(state.image, 0, 0, canvas.width, canvas.height);

    if (hasSeparateAnnotationLayer) {
      annotationContext.clearRect(0, 0, annotationLayer.width, annotationLayer.height);
    }
    drawContext = annotationContext;

    for (const operation of state.operations) {
      drawOperation(operation);
    }

    if (state.draft !== null) {
      drawOperation(state.draft);
    }

    // 标注独立绘制在透明图层上，橡皮擦只清除标注，不会破坏用户原图。
    drawContext = context;
    if (hasSeparateAnnotationLayer) {
      context.drawImage(annotationLayer, 0, 0);
    }
  }

  function drawOperation(operation) {
    drawContext.save();
    drawContext.lineCap = "round";
    drawContext.lineJoin = "round";
    drawContext.strokeStyle = operation.color;

    if (operation.type === "brush" || operation.type === "eraser") {
      if (operation.type === "eraser") {
        drawContext.globalCompositeOperation = "destination-out";
      }
      drawBrush(operation);
    } else if (operation.type === "rectangle") {
      drawRectangle(operation);
    } else {
      drawMarker(operation);
    }

    drawContext.restore();
  }

  function drawBrush(operation) {
    if (operation.points.length === 0) {
      return;
    }

    drawContext.lineWidth = operation.type === "eraser" ? operation.width * 2 : operation.width;
    drawContext.beginPath();
    drawContext.moveTo(operation.points[0].x, operation.points[0].y);

    for (const point of operation.points.slice(1)) {
      drawContext.lineTo(point.x, point.y);
    }

    drawContext.stroke();
  }

  function drawRectangle(operation) {
    const x = Math.min(operation.start.x, operation.end.x);
    const y = Math.min(operation.start.y, operation.end.y);
    const width = Math.abs(operation.end.x - operation.start.x);
    const height = Math.abs(operation.end.y - operation.start.y);

    drawContext.lineWidth = operation.width;
    drawContext.globalAlpha = 0.18;
    drawContext.fillStyle = operation.color;
    drawContext.fillRect(x, y, width, height);
    drawContext.globalAlpha = 1;
    drawContext.strokeRect(x, y, width, height);
  }

  function drawMarker(operation) {
    const radius = Math.max(16, Math.min(canvas.width, canvas.height) * 0.025);

    drawContext.fillStyle = operation.color;
    drawContext.beginPath();
    drawContext.arc(operation.point.x, operation.point.y, radius, 0, Math.PI * 2);
    drawContext.fill();
    drawContext.lineWidth = Math.max(2, radius * 0.12);
    drawContext.strokeStyle = "#ffffff";
    drawContext.stroke();
    drawContext.fillStyle = "#ffffff";
    drawContext.font = `700 ${String(Math.round(radius * 1.15))}px sans-serif`;
    drawContext.textAlign = "center";
    drawContext.textBaseline = "middle";
    drawContext.fillText(String(operation.number), operation.point.x, operation.point.y + 1);
  }

  function resolveCanvasPoint(event) {
    const bounds = canvas.getBoundingClientRect();

    return {
      x: ((event.clientX - bounds.left) / bounds.width) * canvas.width,
      y: ((event.clientY - bounds.top) / bounds.height) * canvas.height
    };
  }

  function countMarkers() {
    return state.operations.filter((operation) => operation.type === "marker").length;
  }

  function releaseImageObjectUrl() {
    if (state.imageObjectUrl !== null) {
      URL.revokeObjectURL(state.imageObjectUrl);
      state.imageObjectUrl = null;
    }
  }

  return {
    exportPngBlob,
    hasAnnotations,
    loadImage,
    reset,
    setColor,
    setTool,
    setWidth,
    undo
  };
}

async function loadImageElement(url) {
  const image = new Image();
  image.src = url;

  try {
    await image.decode();
  } catch {
    throw new Error("图片格式无法用于标注，请重新生成或下载后上传。");
  }

  return image;
}
