import assert from "node:assert/strict";
import test from "node:test";

import { HttpAiGatewayImageGenerationClient } from "../src/infrastructure/ai/ai-gateway-client.js";

void test("OpenRouter 图片模型使用 chat completions 并解析 message images", async () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; body: Record<string, unknown> }[] = [];

  globalThis.fetch = (url, init) => {
    const body = JSON.parse(readMockRequestBody(init)) as Record<string, unknown>;
    requests.push({ url: readMockRequestUrl(url), body });

    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: "or_request_001",
          choices: [
            {
              message: {
                role: "assistant",
                content: "已生成图片。",
                images: [
                  {
                    type: "image_url",
                    image_url: {
                      url: "data:image/png;base64,aW1hZ2UtMQ=="
                    }
                  }
                ]
              }
            }
          ],
          usage: { total_tokens: 12 }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );
  };

  try {
    const client = new HttpAiGatewayImageGenerationClient({
      aiGatewayBaseUrl: "https://openrouter.ai/api/v1",
      aiGatewayApiKey: "test-key"
    });
    const result = await client.generateImage({
      model: "google/gemini-3.1-flash-lite-image",
      prompt: "一只玻璃质感的蓝色水晶杯",
      negativePrompt: "低清晰度",
      size: "1024x1024",
      count: 1
    });

    assert.equal(requests[0]?.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(requests[0]?.body.model, "google/gemini-3.1-flash-lite-image");
    assert.deepEqual(requests[0]?.body.modalities, ["image", "text"]);
    assert.match(JSON.stringify(requests[0]?.body.messages), /目标尺寸 1024x1024/);
    assert.equal(result.request_id, "or_request_001");
    assert.deepEqual(result.images, [
      {
        mime_type: "image/png",
        content_base64: "aW1hZ2UtMQ=="
      }
    ]);
    assert.deepEqual(result.usage, { total_tokens: 12 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test("普通 OpenAI 图片网关继续使用 images generations", async () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; body: Record<string, unknown> }[] = [];

  globalThis.fetch = (url, init) => {
    const body = JSON.parse(readMockRequestBody(init)) as Record<string, unknown>;
    requests.push({ url: readMockRequestUrl(url), body });

    return Promise.resolve(
      new Response(
        JSON.stringify({
          request_id: "img_request_001",
          data: [{ b64_json: "aW1hZ2UtMg==", mime_type: "image/webp" }]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );
  };

  try {
    const client = new HttpAiGatewayImageGenerationClient({
      aiGatewayBaseUrl: "https://gateway.example.com/v1",
      aiGatewayApiKey: "test-key"
    });
    const result = await client.generateImage({
      model: "image-model",
      prompt: "海报背景",
      size: "1024x1024",
      count: 1
    });

    assert.equal(requests[0]?.url, "https://gateway.example.com/v1/images/generations");
    assert.equal(requests[0]?.body.response_format, "b64_json");
    assert.deepEqual(result.images, [
      {
        mime_type: "image/webp",
        content_base64: "aW1hZ2UtMg=="
      }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function readMockRequestBody(init: RequestInit | undefined): string {
  return typeof init?.body === "string" ? init.body : "{}";
}

function readMockRequestUrl(url: Parameters<typeof fetch>[0]): string {
  if (typeof url === "string") {
    return url;
  }

  if (url instanceof URL) {
    return url.toString();
  }

  return url.url;
}
