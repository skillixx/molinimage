import sharp from "sharp";

export interface ImageOutputPostProcessInput {
  mimeType: string;
  contentBase64: string;
  targetSize: string;
}

export interface ImageOutputPostProcessResult {
  mimeType: string;
  contentBase64: string;
}

export interface ImageOutputPostProcessor {
  normalizeToTargetSize(input: ImageOutputPostProcessInput): Promise<ImageOutputPostProcessResult>;
}

export class NoopImageOutputPostProcessor implements ImageOutputPostProcessor {
  normalizeToTargetSize(input: ImageOutputPostProcessInput): Promise<ImageOutputPostProcessResult> {
    return Promise.resolve({
      mimeType: input.mimeType,
      contentBase64: input.contentBase64
    });
  }
}

export class SharpImageOutputPostProcessor implements ImageOutputPostProcessor {
  async normalizeToTargetSize(
    input: ImageOutputPostProcessInput
  ): Promise<ImageOutputPostProcessResult> {
    const target = parseTargetSize(input.targetSize);

    if (target === null) {
      return {
        mimeType: input.mimeType,
        contentBase64: input.contentBase64
      };
    }

    const source = Buffer.from(input.contentBase64, "base64");
    const normalized = await sharp(source)
      .resize(target.width, target.height, {
        // 生成图最终下载尺寸必须严格等于用户选择值，超出部分居中裁剪，避免出现留白边。
        fit: "cover",
        position: "centre"
      })
      .toFormat(resolveSharpFormat(input.mimeType))
      .toBuffer();

    return {
      mimeType: normalizeOutputMimeType(input.mimeType),
      contentBase64: normalized.toString("base64")
    };
  }
}

function parseTargetSize(value: string): { width: number; height: number } | null {
  const match = /^([1-9]\d{1,4})x([1-9]\d{1,4})$/u.exec(value.trim());

  if (match === null) {
    return null;
  }

  return {
    width: Number(match[1]),
    height: Number(match[2])
  };
}

function resolveSharpFormat(mimeType: string): "png" | "jpeg" | "webp" {
  const normalized = mimeType.trim().toLowerCase();

  if (normalized === "image/webp") {
    return "webp";
  }

  if (normalized === "image/jpeg" || normalized === "image/jpg") {
    return "jpeg";
  }

  return "png";
}

function normalizeOutputMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();

  if (normalized === "image/webp") {
    return "image/webp";
  }

  if (normalized === "image/jpeg" || normalized === "image/jpg") {
    return "image/jpeg";
  }

  return "image/png";
}
