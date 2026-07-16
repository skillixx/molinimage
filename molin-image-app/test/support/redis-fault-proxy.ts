import { createConnection, createServer, type Server, type Socket } from "node:net";

export class RedisFaultProxy {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private listenPort = 0;

  private constructor(
    private readonly targetHost: string,
    private readonly targetPort: number,
    private readonly sourceUrl: URL
  ) {
    this.server = createServer((client) => {
      this.forward(client);
    });
  }

  static async start(redisUrl: string): Promise<RedisFaultProxy> {
    const sourceUrl = new URL(redisUrl);
    if (sourceUrl.protocol !== "redis:") {
      throw new Error("G09 Redis 中断测试当前只支持明文 Redis 测试实例。");
    }

    const proxy = new RedisFaultProxy(
      sourceUrl.hostname,
      Number(sourceUrl.port || "6379"),
      sourceUrl
    );
    await proxy.listen(0);
    return proxy;
  }

  get redisUrl(): string {
    const proxyUrl = new URL(this.sourceUrl);
    proxyUrl.hostname = "127.0.0.1";
    proxyUrl.port = String(this.listenPort);
    return proxyUrl.toString();
  }

  async pause(): Promise<void> {
    // server.close 会等待现有连接结束，因此先发起停止监听，再销毁存量连接并等待完成。
    const stopped = this.stopListening();
    // 同时销毁上下游 socket，确保现有 ioredis 连接真实进入 reconnecting 状态。
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    await stopped;
  }

  async resume(): Promise<void> {
    await this.listen(this.listenPort);
  }

  async close(): Promise<void> {
    await this.pause();
  }

  private forward(client: Socket): void {
    const upstream = createConnection({ host: this.targetHost, port: this.targetPort });
    this.track(client);
    this.track(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  }

  private track(socket: Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }

  private async listen(port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        const address = this.server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("G09 Redis 故障代理监听失败。"));
          return;
        }

        this.listenPort = address.port;
        resolve();
      });
    });
  }

  private async stopListening(): Promise<void> {
    if (!this.server.listening) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error === undefined) {
          resolve();
          return;
        }

        reject(error);
      });
    });
  }
}
