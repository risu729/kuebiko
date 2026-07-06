import CDP from "chrome-remote-interface";
import type { Protocol } from "devtools-protocol";

import { matchesFilters } from "./sanitize";
import type {
  CompletedResponseMetadata,
  ErrorRecord,
  RequestState,
  RequestBodySaveResult,
  RequestBodySource,
  SessionInfo,
  StartLoggerOptions,
} from "./types";

type CdpClient = CDP.Client;
type TargetAttachedEvent = Protocol.Target.AttachedToTargetEvent;
type TargetDetachedEvent = Protocol.Target.DetachedFromTargetEvent;
type RequestWillBeSentEvent = Protocol.Network.RequestWillBeSentEvent;
type ResponseReceivedEvent = Protocol.Network.ResponseReceivedEvent;
type LoadingFinishedEvent = Protocol.Network.LoadingFinishedEvent;
type LoadingFailedEvent = Protocol.Network.LoadingFailedEvent;
type WebSocketFrameReceivedEvent = Protocol.Network.WebSocketFrameReceivedEvent;

const TARGET_TYPES = new Set(["page", "iframe", "worker", "shared_worker", "service_worker"]);

const NETWORK_BUFFER_OPTIONS = {
  maxResourceBufferSize: 100 * 1024 * 1024,
  maxTotalBufferSize: 500 * 1024 * 1024,
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const nowIso = (): string => new Date().toISOString();

const requestKey = (sessionId: string, requestId: string): string => `${sessionId}:${requestId}`;

const requestBodyErrorEvent = (source: RequestBodySource | undefined): string =>
  source === "requestWillBeSent"
    ? "Network.requestWillBeSent.postData"
    : "Network.getRequestPostData";

const createErrorRecord = (
  event: string,
  session: SessionInfo | undefined,
  error: unknown,
  requestId?: string,
  url?: string,
): ErrorRecord => ({
  error: errorMessage(error),
  event,
  requestId,
  sessionId: session?.sessionId,
  targetId: session?.targetId,
  timestamp: nowIso(),
  url,
});

const createCompletedMetadata = (
  state: RequestState,
  finished: LoadingFinishedEvent,
  bodyResult: {
    base64Encoded?: boolean | undefined;
    bodyFile?: string | undefined;
    bodyLength?: number | undefined;
    bodySaved: boolean;
    bodySha256?: string | undefined;
    error?: string | undefined;
  },
  requestBodyResult: Partial<RequestBodySaveResult>,
  runTimestamp: string,
): CompletedResponseMetadata => {
  const response = state.response;

  return {
    base64Encoded: bodyResult.base64Encoded,
    bodyFile: bodyResult.bodyFile,
    bodyLength: bodyResult.bodyLength,
    bodySaved: bodyResult.bodySaved,
    bodySha256: bodyResult.bodySha256,
    encodedDataLength: finished.encodedDataLength,
    error: bodyResult.error,
    fromDiskCache: response?.fromDiskCache,
    fromPrefetchCache: response?.fromPrefetchCache,
    fromServiceWorker: response?.fromServiceWorker,
    loaderId: state.loaderId,
    mimeType: response?.mimeType,
    protocol: response?.protocol,
    remoteIPAddress: response?.remoteIPAddress,
    remotePort: response?.remotePort,
    requestBodyError: requestBodyResult.error,
    requestBodyFile: requestBodyResult.bodyFile,
    requestBodyLength: requestBodyResult.bodyLength,
    requestBodySaved: requestBodyResult.bodySaved,
    requestBodySha256: requestBodyResult.bodySha256,
    requestBodySource: requestBodyResult.source,
    requestHeaders: state.requestHeaders,
    requestId: state.requestId,
    requestMethod: state.requestMethod,
    responseHeaders: response?.headers,
    runTimestamp,
    sessionId: state.session.sessionId,
    status: response?.status,
    statusText: response?.statusText,
    tabTargetId: state.session.targetId,
    targetType: state.session.targetType,
    targetUrl: state.session.targetUrl,
    type: state.type,
    url: response?.url ?? state.requestUrl,
  };
};

const isInspectableTarget = (targetInfo: Protocol.Target.TargetInfo): boolean =>
  TARGET_TYPES.has(targetInfo.type);

const headerValue = (
  headers: Protocol.Network.Headers | undefined,
  name: string,
): string | undefined => {
  const wanted = name.toLowerCase();
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === wanted);
  const value = entry?.[1];

  if (Array.isArray(value)) {
    return value.join(", ");
  }

  return typeof value === "string" ? value : undefined;
};

class CdpResponseLogger {
  readonly #client: CdpClient;
  readonly #options: StartLoggerOptions;
  readonly #requests = new Map<string, RequestState>();
  readonly #sessions = new Map<string, SessionInfo>();

  constructor(client: CdpClient, options: StartLoggerOptions) {
    this.#client = client;
    this.#options = options;
  }

  async start(): Promise<void> {
    this.#registerEvents();
    await this.#client.Target.setDiscoverTargets({ discover: true });
    await this.#client.Target.setAutoAttach({
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: false,
    });
    await this.#attachExistingTargets();
  }

  async close(): Promise<void> {
    await this.#client.close();
  }

  #log(message: string): void {
    process.stdout.write(`${message}\n`);
  }

  #verbose(message: string): void {
    if (this.#options.verbose) {
      this.#log(message);
    }
  }

  #registerEvents(): void {
    this.#client.on("Target.attachedToTarget", (event) => {
      void this.#handleAttached(event);
    });
    this.#client.on("Target.detachedFromTarget", (event) => {
      void this.#handleDetached(event);
    });
    this.#client.on("Network.requestWillBeSent", (event, sessionId) => {
      this.#handleRequestWillBeSent(event as RequestWillBeSentEvent, sessionId);
    });
    this.#client.on("Network.responseReceived", (event, sessionId) => {
      this.#handleResponseReceived(event as ResponseReceivedEvent, sessionId);
    });
    this.#client.on("Network.loadingFinished", (event, sessionId) => {
      void this.#handleLoadingFinished(event as LoadingFinishedEvent, sessionId);
    });
    this.#client.on("Network.loadingFailed", (event, sessionId) => {
      void this.#handleLoadingFailed(event as LoadingFailedEvent, sessionId);
    });
    this.#client.on("Network.webSocketFrameReceived", (event, sessionId) => {
      void this.#handleWebSocketFrameReceived(event as WebSocketFrameReceivedEvent, sessionId);
    });
    this.#client.on("disconnect", () => {
      this.#log("cdp disconnected");
    });
  }

  async #attachExistingTargets(): Promise<void> {
    const { targetInfos } = await this.#client.Target.getTargets({});
    for (const targetInfo of targetInfos) {
      if (!isInspectableTarget(targetInfo)) {
        continue;
      }

      try {
        await this.#client.Target.attachToTarget({
          flatten: true,
          targetId: targetInfo.targetId,
        });
      } catch (error) {
        await this.#options.storage.recordError(
          createErrorRecord(
            "Target.attachToTarget",
            {
              sessionId: "",
              targetId: targetInfo.targetId,
              targetType: targetInfo.type,
              targetUrl: targetInfo.url,
            },
            error,
          ),
        );
      }
    }
  }

  async #handleAttached(event: TargetAttachedEvent): Promise<void> {
    const session: SessionInfo = {
      sessionId: event.sessionId,
      targetId: event.targetInfo.targetId,
      targetType: event.targetInfo.type,
      targetUrl: event.targetInfo.url,
    };
    this.#sessions.set(event.sessionId, session);

    if (!isInspectableTarget(event.targetInfo)) {
      this.#verbose(`skip target type=${event.targetInfo.type} id=${event.targetInfo.targetId}`);
      return;
    }

    await this.#resumeIfWaitingForDebugger(event, session);

    try {
      await this.#client.Network.enable(NETWORK_BUFFER_OPTIONS, event.sessionId);
      this.#log(`attached target=${event.targetInfo.type} session=${event.sessionId}`);
    } catch (error) {
      await this.#options.storage.recordError(createErrorRecord("Network.enable", session, error));
    }
  }

  async #resumeIfWaitingForDebugger(
    event: TargetAttachedEvent,
    session: SessionInfo,
  ): Promise<void> {
    if (!event.waitingForDebugger) {
      return;
    }

    try {
      await this.#client.send("Runtime.runIfWaitingForDebugger", undefined, event.sessionId);
      this.#log(`resumed waiting target=${event.targetInfo.type} session=${event.sessionId}`);
    } catch (error) {
      await this.#options.storage.recordError(
        createErrorRecord(
          "Runtime.runIfWaitingForDebugger",
          session,
          error,
          undefined,
          session.targetUrl,
        ),
      );
    }
  }

  async #handleDetached(event: TargetDetachedEvent): Promise<void> {
    const session = this.#sessions.get(event.sessionId);
    this.#sessions.delete(event.sessionId);

    for (const [key, state] of this.#requests) {
      if (state.session.sessionId === event.sessionId) {
        this.#requests.delete(key);
      }
    }

    this.#verbose(`detached session=${event.sessionId}`);
    if (session) {
      await this.#options.storage.recordError({
        error: "Target detached before all active requests completed.",
        event: "Target.detachedFromTarget",
        sessionId: event.sessionId,
        targetId: session.targetId,
        timestamp: nowIso(),
        url: session.targetUrl,
      });
    }
  }

  #handleRequestWillBeSent(event: RequestWillBeSentEvent, sessionId?: string): void {
    if (!sessionId) {
      return;
    }
    const session = this.#sessions.get(sessionId) ?? { sessionId };
    const key = requestKey(sessionId, event.requestId);

    this.#requests.set(key, {
      frameId: event.frameId,
      hasPostData: event.request.hasPostData,
      initiator: event.initiator,
      loaderId: event.loaderId,
      requestContentType: headerValue(event.request.headers, "content-type"),
      requestHeaders: event.request.headers,
      requestId: event.requestId,
      requestMethod: event.request.method,
      requestPostData: event.request.postData,
      requestTime: nowIso(),
      requestUrl: event.request.url,
      session,
      type: event.type,
    });
  }

  #handleResponseReceived(event: ResponseReceivedEvent, sessionId?: string): void {
    if (!sessionId) {
      return;
    }
    const key = requestKey(sessionId, event.requestId);
    const session = this.#sessions.get(sessionId) ?? { sessionId };
    const existing = this.#requests.get(key);

    this.#requests.set(key, {
      ...existing,
      loaderId: existing?.loaderId ?? event.loaderId,
      requestId: event.requestId,
      response: event.response,
      session,
      type: event.type,
    });
  }

  async #handleLoadingFinished(event: LoadingFinishedEvent, sessionId?: string): Promise<void> {
    if (!sessionId) {
      return;
    }
    const key = requestKey(sessionId, event.requestId);
    const state = this.#requests.get(key);
    if (!state) {
      return;
    }

    this.#requests.delete(key);

    const url = state.response?.url ?? state.requestUrl;
    if (!matchesFilters(url, this.#options.include, this.#options.exclude)) {
      return;
    }

    const bodyResult = await this.#getBodyResult(state, event);
    const requestBodyResult = await this.#getRequestBodyResult(state);
    await this.#options.storage.recordCompletedResponse(
      createCompletedMetadata(
        state,
        event,
        bodyResult,
        requestBodyResult,
        this.#options.storage.runTimestamp,
      ),
    );

    if (!bodyResult.bodySaved && bodyResult.error) {
      await this.#recordRequestError("Network.getResponseBody", state, bodyResult.error, url);
    }

    if (!requestBodyResult.bodySaved && requestBodyResult.error) {
      await this.#recordRequestError(
        requestBodyErrorEvent(requestBodyResult.source),
        state,
        requestBodyResult.error,
        url,
      );
    }
  }

  async #recordRequestError(
    event: string,
    state: RequestState,
    error: string,
    url: string | undefined,
  ): Promise<void> {
    await this.#options.storage.recordError(
      createErrorRecord(event, state.session, error, state.requestId, url),
    );
  }

  async #getRequestBodyResult(state: RequestState): Promise<Partial<RequestBodySaveResult>> {
    if (state.requestPostData !== undefined) {
      return await this.#options.storage.recordRequestBody(state, state.requestPostData);
    }

    if (!state.hasPostData) {
      return {};
    }

    try {
      const body = await this.#client.Network.getRequestPostData(
        { requestId: state.requestId },
        state.session.sessionId,
      );
      if (typeof body.postData !== "string") {
        return {
          bodySaved: false,
          error: "Network.getRequestPostData returned no postData.",
          source: "getRequestPostData",
        };
      }

      return await this.#options.storage.recordRequestBody(state, body.postData);
    } catch (error) {
      return {
        bodySaved: false,
        error: errorMessage(error),
        source: "getRequestPostData",
      };
    }
  }

  async #getBodyResult(
    state: RequestState,
    event: LoadingFinishedEvent,
  ): Promise<{
    base64Encoded?: boolean | undefined;
    bodyFile?: string | undefined;
    bodyLength?: number | undefined;
    bodySaved: boolean;
    bodySha256?: string | undefined;
    error?: string | undefined;
  }> {
    if (
      this.#options.maxBodyBytes !== undefined &&
      event.encodedDataLength > this.#options.maxBodyBytes
    ) {
      return {
        bodySaved: false,
        error: `Skipped because encodedDataLength ${event.encodedDataLength} exceeds --max-body-bytes ${this.#options.maxBodyBytes}.`,
      };
    }

    try {
      const body = await this.#client.Network.getResponseBody(
        { requestId: state.requestId },
        state.session.sessionId,
      );
      return await this.#options.storage.recordBody(
        state,
        body as Protocol.Network.GetResponseBodyResponse,
      );
    } catch (error) {
      return {
        bodySaved: false,
        error: errorMessage(error),
      };
    }
  }

  async #handleLoadingFailed(event: LoadingFailedEvent, sessionId?: string): Promise<void> {
    if (!sessionId) {
      return;
    }
    const key = requestKey(sessionId, event.requestId);
    const state = this.#requests.get(key);
    this.#requests.delete(key);

    await this.#options.storage.recordError({
      error: event.errorText,
      event: "Network.loadingFailed",
      requestId: event.requestId,
      sessionId,
      targetId: state?.session.targetId,
      timestamp: nowIso(),
      url: state?.response?.url ?? state?.requestUrl,
    });
  }

  async #handleWebSocketFrameReceived(
    event: WebSocketFrameReceivedEvent,
    sessionId?: string,
  ): Promise<void> {
    if (!sessionId) {
      return;
    }
    const state = this.#requests.get(requestKey(sessionId, event.requestId));
    const session = this.#sessions.get(sessionId);
    await this.#options.storage.recordWebSocketFrame({
      direction: "received",
      opcode: event.response.opcode,
      payloadData: event.response.payloadData,
      requestId: event.requestId,
      sessionId,
      targetId: session?.targetId,
      timestamp: nowIso(),
      url: state?.response?.url ?? state?.requestUrl,
    });
  }
}

type StartedCdpLogger = {
  close: () => Promise<void>;
  closed: Promise<void>;
};

const startCdpLogger = async (options: StartLoggerOptions): Promise<StartedCdpLogger> => {
  const endpoint = new URL(options.cdp);
  const connectionOptions = {
    host: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)),
    secure: endpoint.protocol === "https:",
  };
  const version = await CDP.Version(connectionOptions);
  const client = await CDP({ ...connectionOptions, target: version.webSocketDebuggerUrl });
  const closed = new Promise<void>((resolve) => {
    client.on("disconnect", () => resolve());
  });
  const logger = new CdpResponseLogger(client, options);
  await logger.start();
  return {
    close: () => logger.close(),
    closed,
  };
};

export { CdpResponseLogger, NETWORK_BUFFER_OPTIONS, createCompletedMetadata, startCdpLogger };
