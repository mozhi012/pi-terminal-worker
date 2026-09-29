/**
 * 测试专用 Fake Pi 运行时模拟器
 */

import { EventEmitter } from "node:events";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  ToolDefinition,
  InputEvent,
  ToolExecutionStartEvent,
} from "@earendil-works/pi-coding-agent";

export class FakePiContext implements ExtensionContext {
  public ui = {
    setStatus: (key: string, text: string | undefined) => {
      this.statuses.set(key, text);
    },
    notify: (message: string, type: "info" | "warning" | "error" = "info") => {
      this.notifications.push({ message, type });
    },
    confirm: async (_title: string, _message: string): Promise<boolean> => {
      return this.confirmResponse;
    },
    select: async (_title: string, options: string[]) => options[0],
    input: async () => "mock_input",
    onTerminalInput: () => () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => ({} as any),
  };

  public statuses = new Map<string, string | undefined>();
  public notifications: Array<{ message: string; type: string }> = [];
  public confirmResponse = true;
  public idleState = true;
  public pendingMessages = false;
  public aborted = false;
  public shutDown = false;
  public cwd = process.cwd();

  public isIdle(): boolean {
    return this.idleState;
  }

  public hasPendingMessages(): boolean {
    return this.pendingMessages;
  }

  public abort(): void {
    this.aborted = true;
  }

  public shutdown(): void {
    this.shutDown = true;
  }

  // 其他 context 占位实现
  public sessionManager = {} as any;
  public model = { provider: "fake-provider", id: "fake-model-1", name: "Fake Model" } as any;
  public getContextUsage = () => undefined;
  public compact = async () => {};
}

export class FakePiAPI implements Partial<ExtensionAPI> {
  public tools = new Map<string, ToolDefinition>();
  public commands = new Map<string, any>();
  public events = new EventEmitter() as any;
  private eventHandlers = new Map<string, Set<Function>>();
  private activeTools: string[] | null = null;

  public sentUserMessages: Array<{
    content: string;
    options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean };
  }> = [];

  public thinkingLevel: string = "medium";

  public getThinkingLevel(): string {
    return this.thinkingLevel;
  }

  public setThinkingLevel(level: string): void {
    this.thinkingLevel = level;
  }

  public registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  public registerCommand(name: string, options: any): void {
    this.commands.set(name, options);
  }

  public getActiveTools(): string[] {
    return this.activeTools ?? Array.from(this.tools.keys());
  }

  public setActiveTools(names: string[]): void {
    this.activeTools = [...names];
  }

  public sendUserMessage(content: any, options?: any): void {
    this.sentUserMessages.push({ content: String(content), options });
  }

  public on(event: string, handler: Function): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
    return () => {
      this.eventHandlers.get(event)?.delete(handler);
    };
  }

  public async emitPiEvent(event: string, payload: any, ctx: ExtensionContext): Promise<any> {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return;
    let result;
    for (const h of handlers) {
      result = await h(payload, ctx);
    }
    return result;
  }
}
