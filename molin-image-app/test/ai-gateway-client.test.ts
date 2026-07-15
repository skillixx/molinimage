import assert from "node:assert/strict";
import test from "node:test";

import {
  HttpAiGatewayImageEditClient,
  HttpAiGatewayImageGenerationClient,
  HttpAiGatewayPromptOptimizerClient
} from "../src/infrastructure/ai/ai-gateway-client.js";

void test("OpenRouter 文生图使用官方比例参数并解析 data 图片结果", async () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; body: Record<string, unknown> }[] = [];

  globalThis.fetch = (url, init) => {
    const body = JSON.parse(readMockRequestBody(init)) as Record<string, unknown>;
    requests.push({ url: readMockRequestUrl(url), body });

    return Promise.resolve(
      new Response(
        JSON.stringify({
          request_id: "or_request_001",
          data: [{ b64_json: "aW1hZ2UtMQ==", mime_type: "image/png" }],
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
      size: "720x1280",
      count: 1
    });

    assert.equal(requests[0]?.url, "https://openrouter.ai/api/v1/images");
    assert.equal(requests[0]?.body.model, "google/gemini-3.1-flash-lite-image");
    assert.equal(requests[0]?.body.prompt, "一只玻璃质感的蓝色水晶杯\n\n反向提示词：低清晰度");
    assert.equal(requests[0]?.body.resolution, "1K");
    assert.equal(requests[0]?.body.aspect_ratio, "9:16");
    assert.equal(requests[0]?.body.n, 1);
    assert.equal("size" in (requests[0]?.body ?? {}), false);
    assert.equal("response_format" in (requests[0]?.body ?? {}), false);
    assert.equal(result.request_id, "or_request_001");
    assert.deepEqual(result.images, [
      {
        mime_type: "image/png",
        content_base64: "aW1hZ2UtMQ=="
      }
    ]);
    assert.deepEqual(result.usage, { total_tokens: 12 });

    await client.generateImage({
      model: "google/gemini-3.1-flash-lite-image",
      prompt: "生成一张竖版详情页图片",
      size: "896x1152",
      count: 1
    });
    assert.equal(requests[1]?.body.aspect_ratio, "4:5");

    await assert.rejects(
      client.generateImage({
        model: "google/gemini-3.1-flash-lite-image",
        prompt: "非法尺寸不应请求上游",
        size: "invalid-size",
        count: 1
      }),
      /OpenRouter 图片尺寸格式无效/u
    );
    assert.equal(requests.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test("OpenRouter 其他图片模型保留通用 size 和 n 参数", async () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; body: Record<string, unknown> }[] = [];

  globalThis.fetch = (url, init) => {
    requests.push({
      url: readMockRequestUrl(url),
      body: JSON.parse(readMockRequestBody(init)) as Record<string, unknown>
    });

    return Promise.resolve(
      new Response(
        JSON.stringify({
          request_id: "or_generic_request_001",
          data: [{ b64_json: "Z2VuZXJpYy1pbWFnZQ==", mime_type: "image/png" }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
  };

  try {
    const client = new HttpAiGatewayImageGenerationClient({
      aiGatewayBaseUrl: "https://openrouter.ai/api/v1",
      aiGatewayApiKey: "test-key"
    });

    await client.generateImage({
      model: "provider/another-image-model",
      prompt: "生成两张方图",
      size: "1024x1024",
      count: 2
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "https://openrouter.ai/api/v1/images");
    assert.equal(requests[0]?.body.size, "1024x1024");
    assert.equal(requests[0]?.body.n, 2);
    assert.equal(requests[0]?.body.response_format, "b64_json");
    assert.equal("aspect_ratio" in (requests[0]?.body ?? {}), false);
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

void test("OpenRouter 图生图使用 chat completions 并携带输入图", async () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; body: Record<string, unknown> }[] = [];

  globalThis.fetch = (url, init) => {
    const body = JSON.parse(readMockRequestBody(init)) as Record<string, unknown>;
    requests.push({ url: readMockRequestUrl(url), body });

    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: "or_edit_request_001",
          choices: [
            {
              message: {
                role: "assistant",
                content: [
                  {
                    type: "image_url",
                    image_url: {
                      url: "data:image/png;base64,ZWRpdGVkLWltYWdl"
                    }
                  }
                ]
              }
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );
  };

  try {
    const client = new HttpAiGatewayImageEditClient({
      aiGatewayBaseUrl: "https://openrouter.ai/api/v1",
      aiGatewayApiKey: "test-key"
    });
    const result = await client.editImage({
      model: "google/gemini-3.1-flash-lite-image",
      imageBase64: "aW5wdXQtaW1hZ2U=",
      imageMimeType: "image/png",
      prompt: "保持主体，换成雪山背景",
      size: "1024x1024",
      count: 1
    });
    const messages = JSON.stringify(requests[0]?.body.messages);

    assert.equal(requests[0]?.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(requests[0]?.body.model, "google/gemini-3.1-flash-lite-image");
    assert.deepEqual(requests[0]?.body.modalities, ["image", "text"]);
    assert.match(messages, /保持主体，换成雪山背景/);
    assert.match(messages, /data:image\/png;base64,aW5wdXQtaW1hZ2U=/);
    assert.deepEqual(result.images, [
      {
        mime_type: "image/png",
        content_base64: "ZWRpdGVkLWltYWdl"
      }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test("OpenRouter 多图生成按 n=1 拆分请求并汇总结果", async () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; body: Record<string, unknown> }[] = [];

  globalThis.fetch = (url, init) => {
    const body = JSON.parse(readMockRequestBody(init)) as Record<string, unknown>;
    requests.push({ url: readMockRequestUrl(url), body });
    const requestNumber = requests.length;

    return Promise.resolve(
      new Response(
        JSON.stringify({
          request_id: `or_request_${String(requestNumber)}`,
          data: [
            {
              b64_json: Buffer.from(`image-${String(requestNumber)}`).toString("base64"),
              mime_type: "image/png"
            }
          ],
          usage: { total_tokens: requestNumber * 10 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
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
      prompt: "生成三张横版海报",
      size: "1280x720",
      count: 3
    });

    assert.equal(requests.length, 3);
    assert.deepEqual(
      requests.map((request) => request.body.n),
      [1, 1, 1]
    );
    assert.deepEqual(
      requests.map((request) => request.body.aspect_ratio),
      ["16:9", "16:9", "16:9"]
    );
    assert.equal(result.request_id, "or_request_1");
    assert.equal(result.images.length, 3);
    assert.deepEqual(result.usage, {
      request_count: 3,
      requests: [
        { request_id: "or_request_1", usage: { total_tokens: 10 } },
        { request_id: "or_request_2", usage: { total_tokens: 20 } },
        { request_id: "or_request_3", usage: { total_tokens: 30 } }
      ]
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test("提示词优化使用 chat completions 并解析文本结果", async () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; body: Record<string, unknown> }[] = [];

  globalThis.fetch = (url, init) => {
    const body = JSON.parse(readMockRequestBody(init)) as Record<string, unknown>;
    requests.push({ url: readMockRequestUrl(url), body });

    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: "prompt_request_001",
          choices: [
            {
              message: {
                role: "assistant",
                content: "一只玻璃质感的蓝色水晶杯，置于柔和自然光下，背景简洁。"
              }
            }
          ],
          usage: { total_tokens: 30 }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );
  };

  try {
    const client = new HttpAiGatewayPromptOptimizerClient({
      aiGatewayBaseUrl: "https://openrouter.ai/api/v1",
      aiGatewayApiKey: "test-key"
    });
    const result = await client.optimizePrompt({
      model: "deepseek/deepseek-v4-flash",
      prompt: "蓝色杯子",
      taskType: "text_to_image"
    });
    const messages = JSON.stringify(requests[0]?.body.messages);

    assert.equal(requests[0]?.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(requests[0]?.body.model, "deepseek/deepseek-v4-flash");
    assert.match(messages, /任务类型：text_to_image/);
    assert.match(messages, /原始提示词：蓝色杯子/);
    assert.equal(result.request_id, "prompt_request_001");
    assert.equal(result.optimized_prompt, "一只玻璃质感的蓝色水晶杯，置于柔和自然光下，背景简洁。");
    assert.deepEqual(result.usage, { total_tokens: 30 });
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
